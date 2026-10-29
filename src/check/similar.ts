// Names close to a popular package, the usual form of typosquatting and of package names an AI model makes up: one or
// two edits away (a missing, extra, changed or swapped letter), or the same name with other separators. Scopes are
// compared as part of the name: on 818 packages published on 2026-10-29, treating @any/cli as close to @angular/cli
// flagged 13% of them, while edits and separators flagged none.

export interface SimilarName {
  /** The popular package the name resembles. */
  match: string;
  /** edit: a letter or two differ; separators: only -, _ or . differ. */
  reason: 'edit' | 'separators';
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps), or limit + 1 once it exceeds limit. */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, (previous2[j - 2] ?? 0) + 1);
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous2 = previous;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

function unscoped(name: string): string {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
}

function normalized(name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]/gu, '');
}

/** Names shorter than this are not compared by edit distance: one edit turns most of them into another real name. */
const MIN_EDIT_LENGTH = 4;

export class PopularNames {
  readonly #names: ReadonlySet<string>;
  readonly #byNormalized = new Map<string, string[]>();
  readonly #list: readonly string[];

  constructor(names: readonly string[]) {
    this.#list = names;
    this.#names = new Set(names);
    for (const name of names) {
      const key = normalized(name);
      const list = this.#byNormalized.get(key) ?? [];
      list.push(name);
      this.#byNormalized.set(key, list);
    }
  }

  has(name: string): boolean {
    return this.#names.has(name);
  }

  /** The popular package `name` resembles, or undefined (also when `name` is itself popular). */
  similar(name: string): SimilarName | undefined {
    if (this.#names.has(name)) return undefined;
    const same = this.#byNormalized.get(normalized(name))?.[0];
    if (same !== undefined) return { match: same, reason: 'separators' };
    const length = unscoped(name).length;
    if (length < MIN_EDIT_LENGTH) return undefined;
    const limit = length <= 8 ? 1 : 2;
    let best: { name: string; distance: number } | undefined;
    for (const candidate of this.#list) {
      if (unscoped(candidate).length < MIN_EDIT_LENGTH) continue;
      const distance = editDistance(name, candidate, limit);
      if (distance <= limit && (best === undefined || distance < best.distance)) best = { name: candidate, distance };
    }
    return best === undefined ? undefined : { match: best.name, reason: 'edit' };
  }
}
