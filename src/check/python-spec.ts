// Python package specs as given to pip, uv, Poetry or pipx: a requirement (PEP 508: name, extras, version
// specifiers, environment markers, or name @ URL), name@version and name@constraint as uv tool commands and Poetry
// write them, or a bare URL or path. Sources other than the index are told apart with pip's own rules (shared with
// doctor's reading of requirements files); environment markers are ignored, so a requirement is checked whatever
// environment it is meant for.
import { values } from '../apply/facts.ts';
import { requirementSource, requirementsFormatOf } from '../doctor/python-lockfiles.ts';
import { environment } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { PoetryConstraintsKnowledge } from '../knowledge/types.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { parseSpecifiers, parseVersion, type Clause } from './pep440.ts';
import type { SpecKind } from './spec.ts';

export interface PythonSpec {
  raw: string;
  kind: SpecKind;
  /** The normalized name: of the registry package, or from "name @ URL" or #egg=. */
  name?: string;
  /** registry: the version clauses; [] allows any version. */
  clauses?: Clause[];
  /** registry: name@latest, the newest version. */
  latest?: boolean;
  /** other: why the spec is not looked up. */
  reason?: string;
}

function pipFormat(): Record<string, unknown> {
  const pip = knowledgeBase.find((tool) => tool.id === 'pip');
  if (pip === undefined) throw new Error('the knowledge base has no pip facts');
  return requirementsFormatOf(pip);
}

function poetry(): PoetryConstraintsKnowledge {
  const fact = knowledgeBase.find((tool) => tool.id === 'poetry')?.extra?.['versionConstraints'];
  const value = fact === undefined ? undefined : (values(fact)[0] as PoetryConstraintsKnowledge | undefined);
  if (value === undefined) throw new Error('the knowledge base has no Poetry version constraint facts');
  return value;
}

const NAME_PATTERN = new RegExp(values(environment.python.namePattern)[0] ?? '^[A-Za-z0-9][A-Za-z0-9._-]*$', 'iu');
/** The characters of a name, optional [extras], the rest; the name is checked against the pattern separately. */
const REQUIREMENT = /^([A-Za-z0-9._-]+)\s*(\[[^[\]]*\])?\s*(.*)$/u;

/** Release numbers of a version, padded to three: 1.2 → [1, 2, 0]. */
function release(text: string): number[] | undefined {
  const version = parseVersion(text);
  if (version === undefined || version.epoch !== 0 || version.release.length > 3) return undefined;
  return [0, 1, 2].map((index) => version.release[index] ?? 0);
}

const join = (numbers: readonly number[]) => numbers.join('.');

/**
 * One Poetry constraint as PEP 440 clauses: ^ allows changes that keep the leftmost non-zero part, ~ allows patch
 * changes (minor changes when only a major version is given), * and x.* allow any version with that prefix, and a
 * bare version means exactly that version.
 */
function poetryClauses(text: string): Clause[] | undefined {
  const syntax = poetry();
  const constraint = text.trim();
  if (constraint === syntax.any) return [];
  if (/^(?:~=|===|==|!=|<=|>=|<|>)/u.test(constraint)) return parseSpecifiers(constraint);
  const bound = (lower: readonly number[], upper: readonly number[]): Clause[] => [
    { operator: '>=', version: join(lower), wildcard: false },
    { operator: '<', version: join(upper), wildcard: false },
  ];
  if (constraint.startsWith(syntax.caret)) {
    const body = constraint.slice(syntax.caret.length).trim();
    const parts = release(body);
    if (parts === undefined) return undefined;
    const given = body.split('.').length;
    // The leftmost non-zero part among those given stays; with only zeros given, the last given part does.
    const nonZero = parts.findIndex((part, index) => index < given && part !== 0);
    const keep = nonZero === -1 ? given - 1 : nonZero;
    return bound(parts, parts.map((part, index) => (index < keep ? part : index === keep ? part + 1 : 0)));
  }
  if (constraint.startsWith(syntax.tilde)) {
    const body = constraint.slice(syntax.tilde.length).trim();
    const parts = release(body);
    if (parts === undefined) return undefined;
    const keep = body.split('.').length === 1 ? 0 : 1;
    return bound(parts, parts.map((part, index) => (index < keep ? part : index === keep ? part + 1 : 0)));
  }
  const wildcard = new RegExp(`^(\\d+(?:\\.\\d+)?)\\.${syntax.any.replace(/[*]/gu, '\\*')}$`, 'u').exec(constraint);
  if (wildcard !== null) {
    const given = (wildcard[1] ?? '').split('.').length;
    const parts = release(wildcard[1] ?? '');
    if (parts === undefined) return undefined;
    return bound(parts, parts.map((part, index) => (index < given - 1 ? part : index === given - 1 ? part + 1 : 0)));
  }
  return parseVersion(constraint) === undefined ? undefined : [{ operator: '==', version: constraint, wildcard: false }];
}

const SOURCE_KINDS = { git: 'git', remoteTarball: 'remoteTarball', file: 'file', directory: 'directory', workspace: 'workspace' } as const;

/** undefined when the text is not a Python package spec. */
export function parsePythonSpec(raw: string, options: { editable?: boolean } = {}): PythonSpec | undefined {
  // Environment markers follow a semicolon; the requirement is checked for every environment.
  const text = (raw.split(';', 1)[0] ?? '').trim();
  if (text === '') return undefined;
  const found = requirementSource(text, pipFormat(), options.editable === true);
  if (found.source === 'unknown') return { raw, kind: 'other', reason: `it installs from ${found.target.split('+', 1)[0]}+ version control, which depcurfew does not look up` };
  if (found.source !== 'registry') {
    return { raw, kind: SOURCE_KINDS[found.source], ...(found.name === undefined || found.source === 'workspace' ? {} : { name: normalizePythonName(found.name) }) };
  }
  const match = REQUIREMENT.exec(text);
  if (match === null || !NAME_PATTERN.test(match[1] ?? '')) return undefined;
  const name = normalizePythonName(match[1] ?? '');
  let rest = (match[3] ?? '').trim();
  if (rest.startsWith(poetry().separator)) {
    const constraint = rest.slice(poetry().separator.length).trim();
    if (constraint === poetry().latest) return { raw, kind: 'registry', name, clauses: [], latest: true };
    const clauses = poetryClauses(constraint);
    return clauses === undefined ? undefined : { raw, kind: 'registry', name, clauses };
  }
  // PEP 508 also allows the specifiers in parentheses: name (>=1.0).
  if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1);
  const clauses = parseSpecifiers(rest);
  return clauses === undefined ? undefined : { raw, kind: 'registry', name, clauses };
}
