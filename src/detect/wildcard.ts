// Wildcard matching without regular expressions: patterns come from untrusted files (depcurfew.json, workspace
// patterns), and a regular expression built from `*a*a*a…` backtracks exponentially. This greedy matcher with one
// backtracking point takes at most length(text) × length(pattern) steps.

/** Whether `text` matches `pattern`, in which `*` stands for any run of characters (including none). */
function matchSegment(text: string, pattern: string): boolean {
  let at = 0;
  let index = 0;
  let star = -1;
  let resume = 0;
  while (at < text.length) {
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
