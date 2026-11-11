// Wildcard matching without regular expressions: patterns come from untrusted files (depcurfew.json, workspace
// patterns), and a regular expression built from `*a*a*a…` backtracks exponentially. This greedy matcher with one
// backtracking point takes at most length(text) × length(pattern) steps.

/** How many more steps a caller lets matching take; matching throws OutOfSteps when they run out. */
export interface StepBudget {
  left: number;
}

/** Thrown when a StepBudget runs out before matching ends. */
export class OutOfSteps extends Error {}

/** Takes `count` steps from the budget, if there is one. */
export function spendSteps(budget: StepBudget | undefined, count: number): void {
  if (budget === undefined) return;
  budget.left -= count;
  if (budget.left < 0) throw new OutOfSteps('out of steps');
}

/**
 * Whether `text` matches `pattern`, in which `*` stands for any run of characters (including none). With a budget,
 * each step of the loop takes one from it (decision D-120: workspace patterns of a package.json in another directory).
 */
export function matchSegment(text: string, pattern: string, budget?: StepBudget): boolean {
  let at = 0;
  let index = 0;
  let star = -1;
  let resume = 0;
  while (at < text.length) {
    spendSteps(budget, 1);
    if (index < pattern.length && pattern[index] === '*') {
      star = index;
      index += 1;
      resume = at;
    } else if (index < pattern.length && pattern[index] === text[at]) {
      index += 1;
      at += 1;
    } else if (star !== -1) {
      index = star + 1;
      resume += 1;
      at = resume;
    } else {
      return false;
    }
  }
  while (pattern[index] === '*') index += 1;
  return index === pattern.length;
}

/** Whether `text` matches `pattern`, in which `*` stands for any characters except `/`. */
export function wildcardMatch(text: string, pattern: string): boolean {
  const parts = text.split('/');
  const patternParts = pattern.split('/');
  return parts.length === patternParts.length && parts.every((part, index) => matchSegment(part, patternParts[index] ?? ''));
}

/** Code points a run of the glob cannot hold: * stops at /, ** at the line terminators (as . of a regular expression). */
const STOPS_STAR = new Set(['/']);
const STOPS_ANY = new Set(['\n', '\r', '\u2028', '\u2029']);

/**
 * A glob of directories in which `*` stands for any run without `/` and `**` for any run without a line terminator,
 * as a function of the text it matches: what the regular expression ^…$ (flag u) that the glob used to be built into
 * matched, code point by code point (decision D-200). The pattern comes from a repository file, so it is never built
 * into a regular expression, which backtracks exponentially on `*a*a*a…`. A run of stars was .* and [^/]* as often
 * as ** and * fit into it (*** was .*[^/]*): two equal runs in a row match what one does, so each run is at most **
 * then *. The text is walked once for each part of the pattern, and a part that matches no prefix ends the walk;
 * each literal reads a character, so at most about 3 × (length(text) + 1) parts are walked.
 */
export function directoryGlob(pattern: string): (text: string) => boolean {
  const tokens: (string | Set<string>)[] = [];
  const push = (token: string | Set<string>) => {
    if (typeof token === 'string' || tokens[tokens.length - 1] !== token) tokens.push(token);
  };
  pattern.split('**').forEach((part, partIndex) => {
    if (partIndex > 0) push(STOPS_ANY);
    part.split('*').forEach((piece, pieceIndex) => {
      if (pieceIndex > 0) push(STOPS_STAR);
      for (const character of piece) push(character);
    });
  });
  return (text) => {
    const input = [...text];
    // reach[j]: the tokens read so far match the first j code points of the text.
    let reach = new Uint8Array(input.length + 1);
    let next = new Uint8Array(input.length + 1);
    reach[0] = 1;
    for (const token of tokens) {
      next.fill(0);
      let any = false;
      if (typeof token === 'string') {
        for (let at = 0; at < input.length; at++) {
          if (reach[at] === 1 && input[at] === token) {
            next[at + 1] = 1;
            any = true;
          }
        }
      } else {
        let open = false;
        for (let at = 0; at <= input.length; at++) {
          open = reach[at] === 1 || (open && !token.has(input[at - 1] ?? ''));
          if (open) {
            next[at] = 1;
            any = true;
          }
        }
      }
      if (!any) return false;
      [reach, next] = [next, reach];
    }
    return reach[input.length] === 1;
  };
}

/** Whether `text` matches the glob of directories `pattern` (directoryGlob). */
export function directoryGlobMatch(text: string, pattern: string): boolean {
  return directoryGlob(pattern)(text);
}
