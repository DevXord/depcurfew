// Package patterns in the policy: a package name or a name pattern with *, without a version. npm packages are
// written as they are; Python packages carry the prefix pypi: and Composer packages the prefix composer:, so a name
// never applies to two registries. This is depcurfew's own grammar, deliberately permissive; generators decide per
// tool whether a pattern is supported.
import type { Ecosystem } from '../knowledge/types.ts';
import { suggest } from './shape.ts';

const NAME = '[A-Za-z0-9~*-][A-Za-z0-9._~*_-]*';
const PYTHON_NAME = '[A-Za-z0-9*](?:[A-Za-z0-9._*-]*[A-Za-z0-9*])?';
/** One part of a Composer name: lowercase, as the schema requires (vendor/name, 04-schema.md#name). */
const COMPOSER_PART = '[a-z0-9*](?:[a-z0-9._*-]*[a-z0-9*])?';

export const PYPI_PREFIX = 'pypi:';
export const COMPOSER_PREFIX = 'composer:';

/** The prefix of each registry but npm, whose names have none. */
const PREFIXES: Readonly<Record<Exclude<Ecosystem, 'npm'>, string>> = { pypi: PYPI_PREFIX, packagist: COMPOSER_PREFIX };

/** Also used as the JSON Schema pattern. The lookaheads reject patterns made only of `*`, which match every package. */
export const PACKAGE_PATTERN = `^(?:${PYPI_PREFIX}(?!\\*+$)${PYTHON_NAME}|${COMPOSER_PREFIX}(?!\\*+/\\*+$)${COMPOSER_PART}/${COMPOSER_PART}|(?!\\*+$)(@${NAME}/)?${NAME})$`;

const GRAMMAR = new RegExp(PACKAGE_PATTERN, 'u');

const PREFIX_LIST = `${PYPI_PREFIX} and ${COMPOSER_PREFIX}`;

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

function validateComposerPattern(pattern: string): string | undefined {
  const name = pattern.slice(COMPOSER_PREFIX.length);
  const example = `e.g. "${COMPOSER_PREFIX}monolog/monolog" or "${COMPOSER_PREFIX}acme/*"`;
  if (name === '') return `write a Composer package name after ${COMPOSER_PREFIX}, ${example}`;
  // composer require takes vendor/name:1.0, vendor/name=1.0 and "vendor/name 1.0".
  const versionAt = name.search(/[:=@<>^~ ]/u);
  if (versionAt > 0) return `versions are not supported; write "${COMPOSER_PREFIX}${name.slice(0, versionAt)}"`;
  if (/^\*+(?:\/\*+)?$/u.test(name)) return 'it matches every package; list packages explicitly';
  if (!name.includes('/')) return `Composer package names are vendor/name; expected a name or a name pattern with *, ${example}`;
  if (name !== name.toLowerCase() && GRAMMAR.test(`${COMPOSER_PREFIX}${name.toLowerCase()}`)) {
    return `Composer package names are lowercase; write "${COMPOSER_PREFIX}${name.toLowerCase()}"`;
  }
  if (!GRAMMAR.test(pattern)) return `expected a Composer package name or a name pattern with *, ${example}`;
  return undefined;
}

/** Returns why the pattern is invalid, or undefined when it is valid. */
export function validatePackagePattern(pattern: string): string | undefined {
  if (pattern === '') return 'must not be empty';
  if (/\s/u.test(pattern)) return 'must not contain spaces';
  if (pattern.startsWith(PYPI_PREFIX)) return validatePythonPattern(pattern);
  if (pattern.startsWith(COMPOSER_PREFIX)) return validateComposerPattern(pattern);
  const prefix = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(pattern);
  if (prefix !== null) {
    const rest = pattern.slice(prefix[0].length);
    const word = prefix[1] ?? '';
    // pypi and composer in another case or misspelled, and packagist, the registry Composer installs from.
    const meant = word.toLowerCase() === 'packagist' ? 'composer' : suggest(word.toLowerCase(), ['pypi', 'composer']);
    if (meant === 'pypi') return `the ecosystem prefixes are ${PREFIX_LIST}; write Python packages as "${PYPI_PREFIX}${rest}"`;
    if (meant === 'composer') return `the ecosystem prefixes are ${PREFIX_LIST}; write Composer packages as "${COMPOSER_PREFIX}${rest.toLowerCase()}"`;
    return `the ecosystem prefixes are ${PREFIX_LIST}; write npm packages without a prefix, e.g. "${rest}"`;
  }
  const nameStart = pattern.startsWith('@') ? pattern.indexOf('/') + 1 : 0;
  const versionAt = pattern.indexOf('@', Math.max(nameStart, 1));
  if (versionAt > 0) return `versions are not supported; write "${pattern.slice(0, versionAt)}"`;
  if (/^\*+$/u.test(pattern)) return 'it matches every package; list packages explicitly';
  if (!GRAMMAR.test(pattern)) {
    // vendor/name without a scope is a Composer name.
    if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9*][a-z0-9._*-]*$/u.test(pattern)) {
      return `npm names have a scope (@scope/name); write Composer packages as "${COMPOSER_PREFIX}${pattern}"`;
    }
    return 'expected a package name or a name pattern with *, e.g. "esbuild", "@scope/name" or "@scope/*"';
  }
  return undefined;
}

/** The ecosystem a policy pattern belongs to. */
export function ecosystemOf(pattern: string): Ecosystem {
  if (pattern.startsWith(PYPI_PREFIX)) return 'pypi';
  return pattern.startsWith(COMPOSER_PREFIX) ? 'packagist' : 'npm';
}

/** The prefix of an ecosystem's names in the policy: pypi:, composer:, or none for npm. */
export function prefixOf(ecosystem: Ecosystem): string {
  return ecosystem === 'npm' ? '' : PREFIXES[ecosystem];
}

/** The patterns of one ecosystem, without their prefix. */
export function patternsFor(patterns: readonly string[], ecosystem: Ecosystem): string[] {
  const prefix = prefixOf(ecosystem);
  return patterns.filter((pattern) => ecosystemOf(pattern) === ecosystem).map((pattern) => pattern.slice(prefix.length));
}
