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
