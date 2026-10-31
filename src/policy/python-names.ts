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
