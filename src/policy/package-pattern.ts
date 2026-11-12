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

/**
 * The prefix of each registry but npm, whose names have none. Ruby gems have no prefix (decision D-152): Bundler has no
 * per-gem setting a name in the policy could go to, so no name of the policy is a gem's; the same holds for Rust crates
 * (Cargo has no per-crate exception, E05).
 */
const PREFIXES: Readonly<Record<Exclude<Ecosystem, 'npm' | 'rubygems' | 'crates'>, string>> = { pypi: PYPI_PREFIX, packagist: COMPOSER_PREFIX };

/** Also used as the JSON Schema pattern. The lookaheads reject patterns made only of `*`, which match every package. */
export const PACKAGE_PATTERN = `^(?:${PYPI_PREFIX}(?!\\*+$)${PYTHON_NAME}|${COMPOSER_PREFIX}(?!\\*+/\\*+$)${COMPOSER_PART}/${COMPOSER_PART}|(?!\\*+$)(@${NAME}/)?${NAME})$`;

const GRAMMAR = new RegExp(PACKAGE_PATTERN, 'u');

const PREFIX_LIST = `${PYPI_PREFIX} and ${COMPOSER_PREFIX}`;
/** The start of every message about a prefix the policy does not take (E33). */
const PREFIXES_ARE = `the ecosystem prefixes are ${PREFIX_LIST}, and npm packages have none`;

/** Prefixes people write for npm packages, which have none in the policy (E33): the hint names the npm name. */
const NPM_WORDS: ReadonlySet<string> = new Set(['npm', 'node', 'npmjs']);
/** Prefixes people write for Python packages, which take pypi: (E33). */
const PYTHON_WORDS: ReadonlySet<string> = new Set(['pip', 'python', 'py']);
/**
 * Prefixes of ecosystems whose packages have no names in the policy, since no setting depcurfew writes takes one: Ruby
 * gems (decision D-152), JSR packages, Rust crates and NuGet packages (E33). The entry has to go; no other spelling of
 * it is right.
 */
const NAMELESS: Readonly<Record<string, string>> = {
  gem: 'Ruby gems',
  gems: 'Ruby gems',
  rubygems: 'Ruby gems',
  ruby: 'Ruby gems',
  bundler: 'Ruby gems',
  jsr: 'JSR packages',
  cargo: 'Rust crates',
  crates: 'Rust crates',
  crate: 'Rust crates',
  nuget: 'NuGet packages',
};

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

/** A vendor/name (or a pattern of one) without a scope, which is how Composer names packages. */
const COMPOSER_LIKE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9*][a-z0-9._*-]*$/u;

/** Returns why the pattern is invalid, or undefined when it is valid. */
export function validatePackagePattern(pattern: string): string | undefined {
  if (pattern === '') return 'must not be empty';
  if (/\s/u.test(pattern)) return 'must not contain spaces';
  if (pattern.startsWith(PYPI_PREFIX)) return validatePythonPattern(pattern);
  if (pattern.startsWith(COMPOSER_PREFIX)) return validateComposerPattern(pattern);
  const prefix = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(pattern);
  if (prefix !== null) {
    const rest = pattern.slice(prefix[0].length);
    const word = (prefix[1] ?? '').toLowerCase();
    if (NPM_WORDS.has(word)) {
      // An example is given only when it is a valid npm name (D-141).
      const example = validatePackagePattern(rest) === undefined ? `"${rest}"` : '"esbuild" or "@scope/name"';
      return `${PREFIXES_ARE}; write npm packages without a prefix, e.g. ${example}`;
    }
    const nameless = Object.hasOwn(NAMELESS, word) ? NAMELESS[word] : undefined;
    if (nameless !== undefined) return `${nameless} have no names in depcurfew.json, since no setting depcurfew writes takes one; remove this entry (${PREFIXES_ARE})`;
    // pypi and composer in another case or misspelled, the words people write for Python, and packagist and php for
    // Composer, which installs PHP packages from Packagist.
    const meant = PYTHON_WORDS.has(word) ? 'pypi' : word === 'packagist' || word === 'php' ? 'composer' : suggest(word, ['pypi', 'composer']);
    if (meant === 'pypi') return `${PREFIXES_ARE}; write Python packages as "${PYPI_PREFIX}${rest}"`;
    if (meant === 'composer') return `${PREFIXES_ARE}; write Composer packages as "${COMPOSER_PREFIX}${rest.toLowerCase()}"`;
    // Any other prefix: what the entry names is not known, so it is not turned into another name (E33).
    return `${PREFIXES_ARE}; remove the entry or fix the spelling of its prefix`;
  }
  const nameStart = pattern.startsWith('@') ? pattern.indexOf('/') + 1 : 0;
  const versionAt = pattern.indexOf('@', Math.max(nameStart, 1));
  if (versionAt > 0) return `versions are not supported; write "${pattern.slice(0, versionAt)}"`;
  if (/^\*+$/u.test(pattern)) return 'it matches every package; list packages explicitly';
  if (!GRAMMAR.test(pattern)) {
    // vendor/name without a scope is a Composer name.
    if (COMPOSER_LIKE.test(pattern)) {
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
  return ecosystem === 'npm' || ecosystem === 'rubygems' || ecosystem === 'crates' ? '' : PREFIXES[ecosystem];
}

/** The patterns of one ecosystem, without their prefix. */
export function patternsFor(patterns: readonly string[], ecosystem: Ecosystem): string[] {
  const prefix = prefixOf(ecosystem);
  return patterns.filter((pattern) => ecosystemOf(pattern) === ecosystem).map((pattern) => pattern.slice(prefix.length));
}
