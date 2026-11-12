// Which /regex/ patterns of a Renovate configuration doctor and apply run, and how much (decision D-200). The pattern
// comes from the repository and runs on V8's backtracking engine, where some shapes take exponential or high
// polynomial time: matchFileNames ["/(a|aa)*z/"] against a workflow named with 200 a's did not finish in 30 s, and 30
// optional parts ([ab]?) take as long without any group. depcurfew does not run such a pattern. What it runs has no
// quantified group, backreference or lookaround, at most one unbounded quantifier (*, + or {n,}), and at most MAX_WAYS
// ways to match apart from that quantifier (each ?, {n,m} and | multiplies them), MAX_WAYS_UNBOUNDED next to an
// unbounded quantifier, so a match tries at most that many paths for each length of the unbounded part at each
// position of the input. Patterns of that shape still take time that grows with the square or the cube of the input,
// and a file can hold thousands of them: RegexBudget runs the patterns of one file up to a fixed amount of work.

/** The most ways to match that depcurfew runs a pattern with. */
export const MAX_WAYS = 256;
/** The same next to an unbounded quantifier: /.*[ab]{0,255}c/ took 191 ms against 300 letters. */
export const MAX_WAYS_UNBOUNDED = 16;
/**
 * The work depcurfew spends on the /regex/ patterns of one Renovate file, in the steps RegexBudget estimates: about a
 * tenth of a second (a step took 0.2 to 1 ns on the patterns of the tests).
 */
export const REGEX_BUDGET = 100_000_000;
/** The steps charged for each character of a pattern compiled. */
const COMPILE_STEPS = 1_000;
/** The cap of the lengths below: past it, the estimate is over the budget anyway. */
const LONG = 1_000_000;

export interface RegexShape {
  /** What the pattern has that depcurfew does not run, as words after "it has"; undefined when it runs it. */
  refused?: string;
  /** The ways to match apart from the unbounded quantifier (capped just above MAX_WAYS). */
  ways: number;
  /** Whether it has an unbounded quantifier. */
  unbounded: boolean;
  /** The most characters one way to match reads apart from that quantifier (capped). */
  length: number;
}

const QUANTIFIER = /(?:[*+?]|\{(\d+)(,(\d*))?\})\??/uy;

/** The shape of a pattern that compiles with the u flag: what depcurfew does not run, and what running it costs. */
export function regexShape(source: string): RegexShape {
  const capWays = (value: number) => Math.min(value, MAX_WAYS + 1);
  const capLength = (value: number) => Math.min(value, LONG);
  // Each open group: the ways and the longest length of its alternatives before the current one, and those of the current one.
  type Frame = { ways: number; length: number; current: number; currentLength: number };
  const stack: Frame[] = [{ ways: 0, length: 0, current: 1, currentLength: 0 }];
  const top = (): Frame => stack[stack.length - 1] ?? { ways: 0, length: 0, current: 1, currentLength: 0 };
  let unbounded = 0;
  const shape = (refused?: string): RegexShape => {
    const frame = top();
    return { ...(refused === undefined ? {} : { refused }), ways: capWays(frame.ways + frame.current), unbounded: unbounded > 0, length: Math.max(frame.length, frame.currentLength) };
  };
  // The atom just read, which a quantifier may follow: a group or anything else (character, class, escape, assertion).
  let atom: { ways: number; length: number; group: boolean } | undefined;
  const commit = (ways = atom?.ways ?? 1, length = atom?.length ?? 1) => {
    if (atom !== undefined) {
      const frame = top();
      frame.current = capWays(frame.current * ways);
      frame.currentLength = capLength(frame.currentLength + length);
    }
    atom = undefined;
  };
  let at = 0;
  while (at < source.length) {
    const character = source[at] ?? '';
    QUANTIFIER.lastIndex = at;
    const quantifier = atom === undefined ? null : QUANTIFIER.exec(source);
    if (quantifier !== null) {
      if (atom?.group === true) return shape('a quantified group');
      const [text, low, comma, high] = quantifier;
      const open = character === '*' || character === '+' || (comma !== undefined && high === '');
      if (open && ++unbounded > 1) return shape('more than one unbounded quantifier (*, + or {n,})');
      const ways = open ? 1 : character === '?' ? 2 : comma === undefined ? 1 : capWays(Number(high) - Number(low) + 1);
      const times = open || character === '?' ? Math.max(1, Number(low ?? 1)) : Number(comma === undefined ? low : high);
      commit(ways, capLength((atom?.length ?? 1) * times));
      at += text.length;
      continue;
    }
    commit();
    if (character === '\\') {
      const next = source[at + 1] ?? '';
      if (/[1-9]/u.test(next) || next === 'k') return shape('a backreference');
      if ((next === 'p' || next === 'P' || next === 'u') && source[at + 2] === '{') at = source.indexOf('}', at) + 1;
      else at += next === 'u' ? 6 : next === 'x' ? 4 : next === 'c' ? 3 : 2;
      atom = { ways: 1, length: 1, group: false };
    } else if (character === '[') {
      at += 1;
      while (at < source.length && source[at] !== ']') at += source[at] === '\\' ? 2 : 1;
      at += 1;
      atom = { ways: 1, length: 1, group: false };
    } else if (character === '(') {
      if (/^\(\?<?[=!]/u.test(source.slice(at, at + 4))) return shape('a lookaround');
      stack.push({ ways: 0, length: 0, current: 1, currentLength: 0 });
      // (?:, (?<name> and modifiers such as (?i:: the group's own text starts after the colon or the name.
      if (source[at + 1] === '?') at = (source[at + 2] === '<' ? source.indexOf('>', at) : source.indexOf(':', at)) + 1;
      else at += 1;
    } else if (character === ')') {
      const group = stack.length > 1 ? stack.pop() : undefined;
      atom = {
        ways: capWays((group?.ways ?? 0) + (group?.current ?? 1)),
        length: Math.max(group?.length ?? 0, group?.currentLength ?? 0),
        group: true,
      };
      at += 1;
    } else if (character === '|') {
      const frame = top();
      frame.ways = capWays(frame.ways + frame.current);
      frame.length = Math.max(frame.length, frame.currentLength);
      frame.current = 1;
      frame.currentLength = 0;
      at += 1;
    } else {
      atom = { ways: 1, length: 1, group: false };
      at += 1;
    }
  }
  commit();
  const result = shape();
  if (result.ways > MAX_WAYS) return shape(`more than ${MAX_WAYS} ways to match (each ?, {n,m} and | multiplies them)`);
  if (result.unbounded && result.ways > MAX_WAYS_UNBOUNDED) {
    return shape(`an unbounded quantifier (*, + or {n,}) and more than ${MAX_WAYS_UNBOUNDED} ways to match (each ?, {n,m} and | multiplies them)`);
  }
  return result;
}

/** Why depcurfew does not run the pattern, as words for a message; undefined when it runs it. `source` compiles with the u flag. */
export function unreadableRegex(source: string): string | undefined {
  return regexShape(source).refused;
}

/** What running a /regex/ gave: its result, a pattern that does not compile, or one depcurfew does not run. */
export type RegexOutcome = { result: boolean } | { invalid: true } | { refused: string; budget?: true };

/**
 * The /regex/ patterns of one Renovate file, run at most once for each input and only up to REGEX_BUDGET steps in
 * all (decision D-200). The steps of a test are an estimate that grows with the ways to match, the input and the
 * length of a match: ways × (n + 1) × min(n + 1, length + 1), and once more × (n + 1) with an unbounded quantifier,
 * for an input of n characters. A test past the budget is not run: depcurfew treats its pattern as one it does not run.
 */
export class RegexBudget {
  #spent = 0;
  readonly #compiled = new Map<string, { regex: RegExp; shape: RegexShape } | null>();
  readonly #results = new Map<string, boolean>();

  test(source: string, flags: string, input: string): RegexOutcome {
    const key = `${flags}\u0000${source}`;
    let compiled = this.#compiled.get(key);
    if (compiled === undefined) {
      const steps = source.length * COMPILE_STEPS;
      if (this.#spent + steps > REGEX_BUDGET) return { refused: 'past the budget', budget: true };
      this.#spent += steps;
      try {
        compiled = { regex: new RegExp(source, flags), shape: regexShape(source) };
      } catch {
        compiled = null;
      }
      this.#compiled.set(key, compiled);
    }
    if (compiled === null) return { invalid: true };
    if (compiled.shape.refused !== undefined) return { refused: compiled.shape.refused };
    const run = `${key}\u0000${input}`;
    const known = this.#results.get(run);
    if (known !== undefined) return { result: known };
    const { ways, unbounded, length } = compiled.shape;
    const size = input.length + 1;
    const steps = ways * size * Math.min(size, length + 1) * (unbounded ? size : 1);
    if (this.#spent + steps > REGEX_BUDGET) return { refused: 'past the budget', budget: true };
    this.#spent += steps;
    const result = compiled.regex.test(input);
    this.#results.set(run, result);
    return { result };
  }
}
