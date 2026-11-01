// Entries of `projects` in the policy: directories of independent projects in the repository (decision D-100), each
// written as a path relative to the repository root with / between directories, so that the same policy means the
// same directories on every machine and can never name a directory outside the repository.

/** Characters no entry may hold: Windows forbids them in file names, and * and ? would read as patterns. */
const FORBIDDEN = /[\\:*?"<>|\u0000-\u001f\u007f]/u;

/** Directories detection never enters, so a project inside one would never be read. */
const SKIPPED = ['node_modules', '.git'];

/**
 * Also used as the JSON Schema pattern: segments of one or more allowed characters, none of them "." or "..",
 * separated by single slashes, without a slash at either end.
 */
export const PROJECT_DIRECTORY_PATTERN =
  '^(?!\\.\\.?(?:/|$))(?!.*/\\.\\.?(?:/|$))(?!(?:.*/)?(?:node_modules|\\.git)(?:/|$))[^/\\\\:*?"<>|\\u0000-\\u001f\\u007f]+(?:/[^/\\\\:*?"<>|\\u0000-\\u001f\\u007f]+)*$';

const EXAMPLE = 'e.g. "frontend" or "services/api"';

/** Returns why the entry is not a usable project directory, or undefined when it is one. */
export function validateProjectDirectory(entry: string): string | undefined {
  if (entry === '') return `must not be empty; write the directory of the project relative to the repository root, ${EXAMPLE}`;
  if (/^[A-Za-z]:/u.test(entry) || entry.startsWith('\\\\')) return `must be relative to the repository root, without a drive letter, ${EXAMPLE}`;
  if (entry.startsWith('/')) {
    const relative = entry.replace(/^\/+/u, '').replace(/\/+$/u, '');
    return relative === '' ? 'is the repository root, which depcurfew configures anyway; remove the entry' : `must be relative to the repository root; write "${relative}"`;
  }
  if (entry.includes('\\')) return `must use / between directories; write "${entry.replaceAll('\\', '/').replace(/\/+$/u, '')}"`;
  if (entry === '.' || entry === './') return 'is the repository root, which depcurfew configures anyway; remove the entry';
  if (entry.endsWith('/')) return `must not end with /; write "${entry.replace(/\/+$/u, '')}"`;
  const segments = entry.split('/');
  if (segments.includes('')) return `must not contain //; write "${segments.filter((segment) => segment !== '').join('/')}"`;
  if (segments.includes('..')) return 'must not contain "..": a project is a directory inside the repository; write its path from the repository root';
  if (segments.includes('.')) {
    const cleaned = segments.filter((segment) => segment !== '.').join('/');
    return cleaned === '' ? 'is the repository root, which depcurfew configures anyway; remove the entry' : `must not contain "." as a directory; write "${cleaned}"`;
  }
  const skipped = segments.find((segment) => SKIPPED.includes(segment));
  if (skipped !== undefined) return `lies in ${skipped}, which depcurfew does not read; list the directory of your own project`;
  if (FORBIDDEN.test(entry)) return `must be a plain directory path: patterns and the characters \\ : * ? " < > | and control characters are not supported, so list each directory, ${EXAMPLE}`;
  return undefined;
}

/** Whether `inner` is a directory inside `outer` (both entries of projects). */
export function isInsideProject(outer: string, inner: string): boolean {
  return inner.startsWith(`${outer}/`);
}
