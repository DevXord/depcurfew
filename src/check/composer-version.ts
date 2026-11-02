// Composer versions and version constraints, for picking the version a constraint installs (decision D-133): the
// normal form of a version, its stability, the constraint syntax of doc/articles/versions.md and the comparison of
// versions, as composer/semver 3.6.0 (src/VersionParser.php, src/Constraint/Constraint.php) and PHP's version_compare
// (ext/standard/versioning.c) do them. The stabilities, their order, the operators, the branch markers and the special
// forms of version_compare come from the knowledge base (extra.stabilities, versionConstraints, versionComparison of
// Composer). The regular expressions follow those of VersionParser; its possessive quantifiers are written so that
// they cannot backtrack (a repeated group consumes one digit at a time), and inputs are limited in length.
import { values } from '../apply/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ComposerConstraintsKnowledge, ComposerStabilitiesKnowledge, VersionCompareKnowledge } from '../knowledge/types.ts';

/** The longest version or constraint depcurfew reads; real ones are a few dozen characters. */
export const MAX_CONSTRAINT_LENGTH = 1000;

function fact<T>(key: string): T {
  const composer = knowledgeBase.find((tool) => tool.id === 'composer');
  const entry = composer?.extra?.[key];
  const value = entry === undefined ? undefined : (values(entry)[0] as T | undefined);
  if (value === undefined) throw new Error(`the knowledge base has no Composer fact ${key}`);
  return value;
}

let cachedStabilities: ComposerStabilitiesKnowledge | undefined;
let cachedSyntax: ComposerConstraintsKnowledge | undefined;
let cachedComparison: VersionCompareKnowledge | undefined;

export function stabilities(): ComposerStabilitiesKnowledge {
  cachedStabilities ??= fact<ComposerStabilitiesKnowledge>('stabilities');
  return cachedStabilities;
}

function syntax(): ComposerConstraintsKnowledge {
  cachedSyntax ??= fact<ComposerConstraintsKnowledge>('versionConstraints');
  return cachedSyntax;
}

function comparison(): VersionCompareKnowledge {
  cachedComparison ??= fact<VersionCompareKnowledge>('versionComparison');
  return cachedComparison;
}

/** The stability of each priority: higher is less stable. */
export function stabilityPriority(stability: string): number {
  const { priorities } = stabilities();
  return Object.hasOwn(priorities, stability) ? (priorities[stability] as number) : Number.POSITIVE_INFINITY;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The stability words a version may carry (stable|beta|b|RC|alpha|a|patch|pl|p), longest first so that beta is not b. */
function modifierWords(): string {
  return Object.keys(stabilities().modifiers)
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
}

let modifierPattern: string | undefined;

/** VersionParser::$modifierRegex: a stability with an optional number, then an optional dev; groups: word, number, dev. */
function modifier(): string {
  // (?:[.-]?\d)* reads the same text as PCRE's ((?:[.-]?\d+)*+) without backtracking over the digits.
  modifierPattern ??= `[._-]?(?:(${modifierWords()})((?:[.-]?\\d)*)?)?([.-]?dev)?`;
  return modifierPattern;
}

function branchPrefix(): string {
  return syntax().branchPrefix;
}

function branchSuffix(): string {
  return syntax().branchSuffix;
}

/** A stability word as composer/semver writes it in a normal form (expandStability): a is alpha, b beta, rc RC, p and pl patch. */
function expandStability(word: string): string {
  const lower = word.toLowerCase();
  const { modifiers } = stabilities();
  return Object.hasOwn(modifiers, lower) ? (modifiers[lower] as string) : lower;
}

/** The stability of a version (VersionParser::parseStability): dev, alpha, beta, RC or stable. */
export function parseStability(version: string): string {
  const text = version.replace(/#.+$/u, '');
  if (text.startsWith(branchPrefix()) || text.endsWith(branchSuffix())) return 'dev';
  const match = new RegExp(`${modifier()}(?:\\+.*)?$`, 'iu').exec(text.toLowerCase());
  if (match?.[3] !== undefined && match[3] !== '') return 'dev';
  const word = match?.[1];
  if (word !== undefined && word !== '') {
    const stability = expandStability(word);
    if (stabilities().order.includes(stability)) return stability;
  }
  return 'stable';
}

/** A stability as composer.json or a flag writes it, in its own spelling (VersionParser::normalizeStability). */
export function normalizeStability(text: string): string | undefined {
  const lower = text.toLowerCase();
  return stabilities().order.find((stability) => stability.toLowerCase() === lower);
}

/** Whether a normal form names a branch (dev-<name>), which only equals itself. */
export function isBranch(version: string): boolean {
  return version.startsWith(branchPrefix());
}

/** VersionParser::normalizeBranch: a branch named like a version becomes 1.2.9999999.9999999-dev, any other dev-<name>. */
function normalizeBranch(name: string): string {
  const trimmed = name.trim();
  const match = /^v?(\d+)(\.(?:\d+|[xX*]))?(\.(?:\d+|[xX*]))?(\.(?:\d+|[xX*]))?$/iu.exec(trimmed);
  if (match !== null) {
    let version = '';
    for (let index = 1; index < 5; index++) version += match[index] === undefined ? '.x' : (match[index] as string).replace(/[*X]/gu, 'x');
    return `${version.replace(/x/gu, '9999999')}${branchSuffix()}`;
  }
  return `${branchPrefix()}${trimmed}`;
}

/** PHP's empty() of a regular expression group: undefined, '' and '0'. */
const empty = (value: string | undefined) => value === undefined || value === '' || value === '0';

/**
 * The normal form of a version (VersionParser::normalize): 1.2 is 1.2.0.0, v2.0-beta1 is 2.0.0.0-beta1, a dev- branch
 * keeps its name, 2.x-dev is 2.9999999.9999999.9999999-dev; undefined when Composer would reject it.
 */
export function normalizeVersion(input: string): string | undefined {
  let version = input.trim();
  if (version.length > MAX_CONSTRAINT_LENGTH) return undefined;
  const alias = /^([^,\s]+) +as +([^,\s]+)$/u.exec(version);
  if (alias !== null) version = alias[1] as string;
  const flag = new RegExp(`${escape(syntax().stabilityFlag)}(?:${stabilities().order.map(escape).join('|')})$`, 'iu').exec(version);
  if (flag !== null) version = version.slice(0, version.length - flag[0].length);
  if (['master', 'trunk', 'default'].includes(version)) version = `${branchPrefix()}${version}`;
  if (version.toLowerCase().startsWith(branchPrefix())) return `${branchPrefix()}${version.slice(branchPrefix().length)}`;
  const build = /^([^,\s+]+)\+\S+$/u.exec(version);
  if (build !== null) version = build[1] as string;
  let normalized: string | undefined;
  let groups: (string | undefined)[] | undefined;
  const classical = new RegExp(`^v?(\\d{1,5})(\\.\\d+)?(\\.\\d+)?(\\.\\d+)?${modifier()}$`, 'iu').exec(version);
  if (classical !== null) {
    normalized = `${classical[1] as string}${empty(classical[2]) ? '.0' : (classical[2] as string)}${empty(classical[3]) ? '.0' : (classical[3] as string)}${empty(classical[4]) ? '.0' : (classical[4] as string)}`;
    groups = [classical[5], classical[6], classical[7]];
  } else {
    const date = new RegExp(`^v?(\\d{4}(?:[.:-]?\\d{2}){1,6}(?:[.:-]?\\d{1,3}){0,2})${modifier()}$`, 'iu').exec(version);
    if (date !== null) {
      normalized = (date[1] as string).replace(/\D/gu, '.');
      groups = [date[2], date[3], date[4]];
    }
  }
  if (normalized !== undefined && groups !== undefined) {
    const [word, number, dev] = groups;
    if (!empty(word)) {
      if (word === 'stable') return normalized;
      normalized += `-${expandStability(word as string)}${number === undefined || number === '' ? '' : number.replace(/^[.-]+/u, '')}`;
    }
    if (!empty(dev)) normalized += branchSuffix();
    return normalized;
  }
  const devBranch = /^(.*?)[.-]?dev$/iu.exec(version);
  if (devBranch !== null) {
    const branch = normalizeBranch(devBranch[1] as string);
    if (!branch.includes(branchPrefix())) return branch;
  }
  return undefined;
}

/** A version as PHP's version_compare reads it (php_canonicalize_version). */
function canonical(version: string): string {
  if (version === '') return '';
  // By character code into a buffer, so that ten thousand versions of hundreds of characters take milliseconds (decision D-136).
  cachedSeparators ??= new Set(comparison().separators.map((separator) => separator.charCodeAt(0)));
  const separators = cachedSeparators;
  const out = new Uint16Array(version.length * 2);
  let length = 0;
  let previous = version.charCodeAt(0);
  out[length++] = previous;
  for (let index = 1; index < version.length; index++) {
    const code = version.charCodeAt(index);
    const last = out[length - 1];
    if (separators.has(code)) {
      if (last !== DOT) out[length++] = DOT;
    } else if ((notDigit(previous) && isDigitCode(code)) || (isDigitCode(previous) && notDigit(code))) {
      if (last !== DOT) out[length++] = DOT;
      out[length++] = code;
    } else if (!isAlnumCode(code)) {
      if (last !== DOT) out[length++] = DOT;
    } else {
      out[length++] = code;
    }
    previous = code;
  }
  return UTF16.decode(new Uint8Array(out.buffer, 0, length * 2));
}

const DOT = 46;
const UTF16 = new TextDecoder('utf-16le');
let cachedSeparators: ReadonlySet<number> | undefined;
const isDigitCode = (code: number) => code >= 48 && code <= 57;
const isAlnumCode = (code: number) => isDigitCode(code) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
const notDigit = (code: number) => !isDigitCode(code) && code !== DOT;

/** A version in the form version_compare compares, to compare many times with compareComparable (decision D-136). */
export function comparableVersion(version: string): string {
  return version.startsWith('#') ? version : canonical(version);
}

/** The order of a part that is a word (compare_special_version_forms): the first special form it starts with. */
function formOrder(part: string): number {
  return comparison().specialForms.find(([name]) => part.startsWith(name))?.[1] ?? -1;
}

const NUMBER_FORM = '#N#';
const isDigitAt = (text: string, index: number) => {
  const character = text[index];
  return character !== undefined && character >= '0' && character <= '9';
};

/** PHP's version_compare(a, b): -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  if (a === '' || b === '') return a === b ? 0 : a !== '' ? 1 : -1;
  return compareComparable(comparableVersion(a), comparableVersion(b));
}

/** version_compare of two versions already in the form of comparableVersion. */
export function compareComparable(v1: string, v2: string): number {
  if (v1 === '' || v2 === '') return v1 === v2 ? 0 : v1 !== '' ? 1 : -1;
  let p1 = 0;
  let p2 = 0;
  let n1: number | null = 0;
  let n2: number | null = 0;
  let compare = 0;
  while (p1 < v1.length && p2 < v2.length && n1 !== null && n2 !== null) {
    const dot1 = v1.indexOf('.', p1);
    const dot2 = v2.indexOf('.', p2);
    n1 = dot1 === -1 ? null : dot1;
    n2 = dot2 === -1 ? null : dot2;
    const part1 = v1.slice(p1, n1 ?? undefined);
    const part2 = v2.slice(p2, n2 ?? undefined);
    if (isDigitAt(part1, 0) && isDigitAt(part2, 0)) {
      compare = Math.sign(Number.parseInt(part1, 10) - Number.parseInt(part2, 10));
    } else if (!isDigitAt(part1, 0) && !isDigitAt(part2, 0)) {
      compare = Math.sign(formOrder(part1) - formOrder(part2));
    } else {
      compare = isDigitAt(part1, 0) ? Math.sign(comparison().numberOrder - formOrder(part2)) : Math.sign(formOrder(part1) - comparison().numberOrder);
    }
    if (compare !== 0) break;
    if (n1 !== null) p1 = n1 + 1;
    if (n2 !== null) p2 = n2 + 1;
  }
  if (compare === 0) {
    if (n1 !== null) compare = isDigitAt(v1, p1) ? 1 : compareComparable(v1.slice(p1), NUMBER_FORM);
    else if (n2 !== null) compare = isDigitAt(v2, p2) ? -1 : compareComparable(NUMBER_FORM, v2.slice(p2));
  }
  return compare;
}

/** One comparison of a constraint, or all of some, or any of some; `all` is *. */
export type Constraint =
  | { kind: 'all' }
  | { kind: 'compare'; operator: '==' | '!=' | '<' | '<=' | '>' | '>='; version: string }
  | { kind: 'and'; parts: Constraint[] }
  | { kind: 'or'; parts: Constraint[] };

const OPERATORS: Readonly<Record<string, '==' | '!=' | '<' | '<=' | '>' | '>='>> = { '=': '==', '==': '==', '!=': '!=', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

/** Whether a normal form matches one comparison (Constraint::matchSpecific with a version): a branch only equals itself. */
function compares(version: string, operator: '==' | '!=' | '<' | '<=' | '>' | '>=', bound: string): boolean {
  const branch = isBranch(version) || isBranch(bound);
  if (operator === '!=') return branch ? version !== bound : compareVersions(version, bound) !== 0;
  if (operator === '==') return isBranch(version) && isBranch(bound) ? version === bound : branch ? false : compareVersions(version, bound) === 0;
  if (branch) return false;
  const order = compareVersions(version, bound);
  return operator === '<' ? order < 0 : operator === '<=' ? order <= 0 : operator === '>' ? order > 0 : order >= 0;
}

/** Whether a version in its normal form matches the constraint. */
export function matches(constraint: Constraint, version: string): boolean {
  switch (constraint.kind) {
    case 'all':
      return true;
    case 'compare':
      return compares(version, constraint.operator, constraint.version);
    case 'and':
      return constraint.parts.every((part) => matches(part, version));
    case 'or':
      return constraint.parts.some((part) => matches(part, version));
  }
}

/** VersionParser::manipulateVersionString: the parts after `position` padded with 0, the one at it raised by `increment`. */
function manipulate(parts: readonly (string | undefined)[], position: number, increment = 0): string | undefined {
  const result = [parts[1], parts[2], parts[3], parts[4]].map((part) => part ?? '');
  for (let index = 4; index > 0; index--) {
    if (index > position) result[index - 1] = '0';
    else if (index === position && increment !== 0) {
      const value = Number.parseInt(result[index - 1] as string, 10);
      if (Number.isNaN(value)) return undefined;
      result[index - 1] = String(value + increment);
    }
  }
  return result.join('.');
}

const compare = (operator: '==' | '!=' | '<' | '<=' | '>' | '>=', version: string): Constraint => ({ kind: 'compare', operator, version });

/** One constraint without || and AND separators (VersionParser::parseConstraint); undefined when Composer rejects it. */
function parseOne(input: string): Constraint[] | undefined {
  let constraint = input;
  const alias = /^([^,\s]+) +as +([^,\s]+)$/u.exec(constraint);
  if (alias !== null) constraint = alias[1] as string;
  const { stabilityFlag, reference } = syntax();
  let stabilityModifier: string | undefined;
  const flag = new RegExp(`^([^,\\s]*?)${escape(stabilityFlag)}(${stabilities().order.map(escape).join('|')})$`, 'iu').exec(constraint);
  if (flag !== null) {
    constraint = flag[1] === '' ? '*' : (flag[1] as string);
    // As composer/semver compares it: with case, so @STABLE still adds a modifier.
    if (flag[2] !== 'stable') stabilityModifier = flag[2];
  }
  const commit = new RegExp(`^(${escape(branchPrefix())}[^,\\s@]+?|[^,\\s@]+?\\.x${escape(branchSuffix())})${escape(reference)}.+$`, 'iu').exec(constraint);
  if (commit !== null) constraint = commit[1] as string;
  const any = /^(v)?[xX*](\.[xX*])*$/iu.exec(constraint);
  if (any !== null) return any[1] !== undefined || any[2] !== undefined ? [compare('>=', `0.0.0.0${branchSuffix()}`)] : [{ kind: 'all' }];

  const versionPattern = `v?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:\\.(\\d+))?(?:${modifier()}|\\.([xX*][.-]?dev))(?:\\+\\S+)?`;
  const { tilde, caret } = syntax();
  const tildeMatch = new RegExp(`^${escape(tilde)}>?${versionPattern}$`, 'iu').exec(constraint);
  if (tildeMatch !== null) {
    if (constraint.startsWith(`${tilde}>`)) return undefined;
    const given = (index: number) => tildeMatch[index] !== undefined && tildeMatch[index] !== '';
    let position = given(4) ? 4 : given(3) ? 3 : given(2) ? 2 : 1;
    if (!empty(tildeMatch[8])) position += 1;
    const suffix = empty(tildeMatch[5]) && empty(tildeMatch[7]) && empty(tildeMatch[8]) ? branchSuffix() : '';
    const low = normalizeVersion(`${constraint}${suffix}`.slice(tilde.length));
    const high = manipulate(tildeMatch, Math.max(1, position - 1), 1);
    if (low === undefined || high === undefined) return undefined;
    return [compare('>=', low), compare('<', `${high}${branchSuffix()}`)];
  }
  const caretMatch = new RegExp(`^${escape(caret)}${versionPattern}$`, 'iu').exec(constraint);
  if (caretMatch !== null) {
    const given = (index: number) => caretMatch[index] !== undefined && caretMatch[index] !== '';
    const position = caretMatch[1] !== '0' || !given(2) ? 1 : caretMatch[2] !== '0' || !given(3) ? 2 : 3;
    const suffix = empty(caretMatch[5]) && empty(caretMatch[7]) && empty(caretMatch[8]) ? branchSuffix() : '';
    const low = normalizeVersion(`${constraint}${suffix}`.slice(caret.length));
    const high = manipulate(caretMatch, position, 1);
    if (low === undefined || high === undefined) return undefined;
    return [compare('>=', low), compare('<', `${high}${branchSuffix()}`)];
  }
  const range = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.[xX*])+$/u.exec(constraint);
  if (range !== null) {
    const position = range[3] !== undefined && range[3] !== '' ? 3 : range[2] !== undefined && range[2] !== '' ? 2 : 1;
    const low = `${manipulate(range, position) ?? ''}${branchSuffix()}`;
    const high = manipulate(range, position, 1);
    if (high === undefined) return undefined;
    if (low === `0.0.0.0${branchSuffix()}`) return [compare('<', `${high}${branchSuffix()}`)];
    return [compare('>=', low), compare('<', `${high}${branchSuffix()}`)];
  }
  const hyphen = new RegExp(`^(${versionPattern}) +- +(${versionPattern})$`, 'iu').exec(constraint);
  if (hyphen !== null) {
    // Groups: 1 the lower end (2-5 its numbers, 6-9 its modifiers), 10 the upper end (11-14, 15-18).
    const lowSuffix = empty(hyphen[6]) && empty(hyphen[8]) && empty(hyphen[9]) ? branchSuffix() : '';
    const low = normalizeVersion(hyphen[1] as string);
    if (low === undefined) return undefined;
    const notEmpty = (value: string | undefined) => value !== undefined && value !== '';
    if ((notEmpty(hyphen[12]) && notEmpty(hyphen[13])) || !empty(hyphen[15]) || !empty(hyphen[17]) || !empty(hyphen[18])) {
      const high = normalizeVersion(hyphen[10] as string);
      if (high === undefined) return undefined;
      return [compare('>=', `${low}${lowSuffix}`), compare('<=', high)];
    }
    if (normalizeVersion(hyphen[10] as string) === undefined) return undefined;
    const high = manipulate(['', hyphen[11], hyphen[12], hyphen[13], hyphen[14]], notEmpty(hyphen[12]) ? 2 : 1, 1);
    if (high === undefined) return undefined;
    return [compare('>=', `${low}${lowSuffix}`), compare('<', `${high}${branchSuffix()}`)];
  }
  const operators = [...syntax().operators].sort((a, b) => b.length - a.length).map(escape).join('|');
  const basic = new RegExp(`^(${operators})?\\s*(.*)$`, 'u').exec(constraint);
  if (basic === null) return undefined;
  const written = basic[2] as string;
  let version = normalizeVersion(written);
  // foobar-dev stands for dev-foobar (composer/semver recovers it), unless an operator is written.
  if (version === undefined && written.endsWith(branchSuffix()) && /^[0-9a-zA-Z\-./]+$/u.test(written)) version = normalizeVersion(`${branchPrefix()}${written.slice(0, -branchSuffix().length)}`);
  if (version === undefined) return undefined;
  const operator = OPERATORS[basic[1] ?? '='] ?? '==';
  if (operator !== '==' && stabilityModifier !== undefined && parseStability(version) === 'stable') {
    version += `-${stabilityModifier}`;
  } else if ((operator === '<' || operator === '>=') && !new RegExp(`-${modifier()}$`, 'iu').test(written) && !written.startsWith(branchPrefix())) {
    version += branchSuffix();
  }
  return [compare(operator, version)];
}

/** Splits AND constraints as VersionParser::parseConstraints does: at a comma or space that is not part of an operator, -, or as. */
const AND_SEPARATOR = /(?<!^|as|[=>< ,]) *(?<!-)[, ](?!-) *(?!,|as|$)/u;

/** A constraint (VersionParser::parseConstraints): || alternatives of AND groups; undefined when Composer rejects it. */
export function parseConstraint(input: string): Constraint | undefined {
  const text = input.trim();
  if (text === '' || text.length > MAX_CONSTRAINT_LENGTH) return undefined;
  const alternatives: Constraint[] = [];
  for (const alternative of text.split(/\s*\|\|?\s*/u)) {
    const parts: Constraint[] = [];
    for (const piece of alternative.split(AND_SEPARATOR)) {
      const parsed = parseOne(piece);
      if (parsed === undefined) return undefined;
      parts.push(...parsed);
    }
    alternatives.push(parts.length === 1 ? (parts[0] as Constraint) : { kind: 'and', parts });
  }
  return alternatives.length === 1 ? (alternatives[0] as Constraint) : { kind: 'or', parts: alternatives };
}

/**
 * The least stable stability a requirement allows (RootPackageLoader::extractStabilityFlags): the least stable
 * @<stability> among its parts, else the stability of an explicit unstable version in it, when that is less stable
 * than `minimum`; undefined when it allows only `minimum`.
 */
export function stabilityFlag(input: string, minimum = stabilities().minimumStability): string | undefined {
  const parts = input
    .trim()
    .split(/\s*\|\|?\s*/u)
    .flatMap((alternative) => alternative.split(AND_SEPARATOR));
  const { stabilityFlag: at } = syntax();
  const words = stabilities().order.map(escape).join('|');
  let flag: string | undefined;
  for (const part of parts) {
    const match = new RegExp(`^[^${escape(at)}]*?${escape(at)}(${words})$`, 'iu').exec(part);
    const stability = match === null ? undefined : normalizeStability(match[1] as string);
    if (stability !== undefined && (flag === undefined || stabilityPriority(stability) > stabilityPriority(flag))) flag = stability;
  }
  if (flag !== undefined) return flag;
  for (const part of parts) {
    const version = part.replace(/^([^,\s@]+) as .+$/u, '$1');
    if (!/^[^,\s@]+$/u.test(version)) continue;
    const stability = parseStability(version);
    if (stability === 'stable' || stabilityPriority(stability) < stabilityPriority(minimum)) continue;
    if (flag === undefined || stabilityPriority(stability) > stabilityPriority(flag)) flag = stability;
  }
  return flag;
}

/** Whether a constraint names a branch: an exact comparison with a dev- version or a numbered branch (1.x-dev). */
export function namesBranch(constraint: Constraint): boolean {
  switch (constraint.kind) {
    case 'all':
      return false;
    case 'compare':
      return constraint.operator === '==' && parseStability(constraint.version) === 'dev';
    case 'and':
    case 'or':
      return constraint.parts.some(namesBranch);
  }
}
