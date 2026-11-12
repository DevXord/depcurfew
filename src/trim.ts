// Trimming a character from the end of a text by a loop instead of a regular expression (decision D-200): /\/+$/u tries
// every position of a long run of slashes and reads the rest of the run from each, so a path of 200,000 slashes in a
// repository file took seconds. The loop reads the run once.

/** `text` without the run of `character` (one UTF-16 code unit, such as '/') at its very end, as replace(/c+$/u, '') does. */
export function trimTrailing(text: string, character: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === character) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}
