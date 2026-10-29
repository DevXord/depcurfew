// Package patterns in the policy: a package name or a name pattern with *, without a version.
// This is depcurfew's own grammar, deliberately permissive; generators decide per tool whether a pattern is supported.

const NAME = '[A-Za-z0-9~*-][A-Za-z0-9._~*-]*';

/** Also used as the JSON Schema pattern. The lookahead rejects patterns made only of `*`, which match every package. */
export const PACKAGE_PATTERN = `^(?!\\*+$)(@${NAME}/)?${NAME}$`;

const GRAMMAR = new RegExp(PACKAGE_PATTERN, 'u');

/** Returns why the pattern is invalid, or undefined when it is valid. */
export function validatePackagePattern(pattern: string): string | undefined {
  if (pattern === '') return 'must not be empty';
  if (/\s/u.test(pattern)) return 'must not contain spaces';
  const nameStart = pattern.startsWith('@') ? pattern.indexOf('/') + 1 : 0;
  const versionAt = pattern.indexOf('@', Math.max(nameStart, 1));
  if (versionAt > 0) return `versions are not supported; write "${pattern.slice(0, versionAt)}"`;
  if (/^\*+$/u.test(pattern)) return 'it matches every package; list packages explicitly';
  if (!GRAMMAR.test(pattern)) {
    return 'expected a package name or a name pattern with *, e.g. "esbuild", "@scope/name" or "@scope/*"';
  }
  return undefined;
}
