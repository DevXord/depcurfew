// Package patterns in the policy: a package name or a name pattern with *, without a version. npm packages are
// written as they are; Python packages carry the prefix pypi:, so a name never applies to both registries.
// This is depcurfew's own grammar, deliberately permissive; generators decide per tool whether a pattern is supported.
import type { Ecosystem } from '../knowledge/types.ts';

const NAME = '[A-Za-z0-9~*-][A-Za-z0-9._~*_-]*';
const PYTHON_NAME = '[A-Za-z0-9*](?:[A-Za-z0-9._*-]*[A-Za-z0-9*])?';

export const PYPI_PREFIX = 'pypi:';

/** Also used as the JSON Schema pattern. The lookaheads reject patterns made only of `*`, which match every package. */
export const PACKAGE_PATTERN = `^(?:${PYPI_PREFIX}(?!\\*+$)${PYTHON_NAME}|(?!\\*+$)(@${NAME}/)?${NAME})$`;

const GRAMMAR = new RegExp(PACKAGE_PATTERN, 'u');

function validatePythonPattern(pattern: string): string | undefined {
  const name = pattern.slice(PYPI_PREFIX.length);
  if (name === '') return `write a Python package name after ${PYPI_PREFIX}, e.g. "${PYPI_PREFIX}requests"`;
  const versionAt = name.search(/[@=<>!~;[ ]/u);
  if (versionAt > 0 && !name.startsWith('@')) return `versions are not supported; write "${PYPI_PREFIX}${name.slice(0, versionAt)}"`;
  if (/^\*+$/u.test(name)) return 'it matches every package; list packages explicitly';
  const example = `e.g. "${PYPI_PREFIX}requests" or "${PYPI_PREFIX}acme-*"`;
  if (name.startsWith('@')) return `Python package names have no scope; expected a name or a name pattern with *, ${example}`;
  if (!GRAMMAR.test(pattern)) return `expected a Python package name or a name pattern with *, ${example}`;
  return undefined;
}

/** Returns why the pattern is invalid, or undefined when it is valid. */
export function validatePackagePattern(pattern: string): string | undefined {
  if (pattern === '') return 'must not be empty';
  if (/\s/u.test(pattern)) return 'must not contain spaces';
  if (pattern.startsWith(PYPI_PREFIX)) return validatePythonPattern(pattern);
  const prefix = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(pattern);
  if (prefix !== null) {
    const rest = pattern.slice(prefix[0].length);
    return prefix[1]?.toLowerCase() === 'pypi'
      ? `the only ecosystem prefix is ${PYPI_PREFIX}; write Python packages as "${PYPI_PREFIX}${rest}"`
      : `the only ecosystem prefix is ${PYPI_PREFIX}; write npm packages without a prefix, e.g. "${rest}"`;
  }
  const nameStart = pattern.startsWith('@') ? pattern.indexOf('/') + 1 : 0;
  const versionAt = pattern.indexOf('@', Math.max(nameStart, 1));
  if (versionAt > 0) return `versions are not supported; write "${pattern.slice(0, versionAt)}"`;
  if (/^\*+$/u.test(pattern)) return 'it matches every package; list packages explicitly';
  if (!GRAMMAR.test(pattern)) {
    return 'expected a package name or a name pattern with *, e.g. "esbuild", "@scope/name" or "@scope/*"';
  }
  return undefined;
}

/** The ecosystem a policy pattern belongs to. */
export function ecosystemOf(pattern: string): Ecosystem {
  return pattern.startsWith(PYPI_PREFIX) ? 'pypi' : 'npm';
}

/** The patterns of one ecosystem, without the pypi: prefix. */
export function patternsFor(patterns: readonly string[], ecosystem: Ecosystem): string[] {
  return patterns.filter((pattern) => ecosystemOf(pattern) === ecosystem).map((pattern) => (ecosystem === 'pypi' ? pattern.slice(PYPI_PREFIX.length) : pattern));
}
