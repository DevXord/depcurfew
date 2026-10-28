import type { DisputedFact, Evidence, UncertainFact, VerifiedFact } from './types.ts';

export interface FactHelpers {
  verified<T>(value: T, source: string, note?: string): VerifiedFact<T>;
  uncertain<T>(value: T, source: string, note: string): UncertainFact<T>;
  evidence<T>(value: T, source: string, note?: string): Evidence<T>;
  disputed<T>(note: string, ...variants: [Evidence<T>, Evidence<T>, ...Evidence<T>[]]): DisputedFact<T>;
}

/** Fact constructors that stamp every fact of one tool module with the date it was verified. */
export function verifiedOn(verifiedAt: string): FactHelpers {
  function evidence<T>(value: T, source: string, note?: string): Evidence<T> {
    return note === undefined ? { value, source, verifiedAt } : { value, source, verifiedAt, note };
  }
  return {
    evidence,
    verified: (value, source, note) => ({ status: 'verified', ...evidence(value, source, note) }),
    uncertain: (value, source, note) => ({ status: 'uncertain', ...evidence(value, source), note }),
    disputed: (note, ...variants) => ({ status: 'disputed', note, variants }),
  };
}
