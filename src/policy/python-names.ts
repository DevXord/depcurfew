// Python package names are compared after normalization (PEP 503): lowercase, with every run of the separator
// characters replaced by one hyphen. The separators come from the knowledge base.
import { evidenceOf } from '../knowledge/facts.ts';
import { environment } from '../knowledge/environment.ts';

const [rule] = evidenceOf(environment.python.nameNormalization);
const SEPARATORS = new RegExp(rule?.value.separators ?? '[-_.]+', 'gu');
const REPLACEMENT = rule?.value.replacement ?? '-';

/** The normalized form of a Python package name or name pattern; `*` stays as it is. */
export function normalizePythonName(name: string): string {
  return name.replace(SEPARATORS, REPLACEMENT).toLowerCase();
}

const SEPARATOR = new RegExp(`^(?:${SEPARATORS.source})$`, 'u');
const REPLACEMENT_LENGTH = REPLACEMENT.toLowerCase().length;

/**
 * The lengths of the normalized forms of the prefixes of a name that end before each of its characters, one character
 * (code point) at a time: `next(character)` gives the length of the normalized prefix before `character` and counts
 * it in. A run of separators counts once, any other character as long as it is in lower case, which does not depend
 * on the characters around it (only U+03A3 lowers by its context, to one character either way), so the lengths are
 * those of normalizePythonName without normalizing every prefix (decision D-168).
 */
export function normalizedLengths(): (character: string) => number {
  let length = 0;
  let separators = false;
  return (character) => {
    const before = length;
    const separator = SEPARATOR.test(character);
    if (!separator) length += character.toLowerCase().length;
    else if (!separators) length += REPLACEMENT_LENGTH;
    separators = separator;
    return before;
  };
}
