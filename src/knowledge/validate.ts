import { walkKnowledge } from './facts.ts';
import { requiredFactPaths } from './schema.ts';
import { ENVIRONMENT_SOURCES, isOfficialSource, OFFICIAL_SOURCES, type SourceRule } from './sources.ts';
import type { EnvironmentKnowledge, ToolKnowledge } from './types.ts';

export interface KnowledgeIssue {
  tool: string;
  path: string;
  message: string;
}

type Report = (message: string) => void;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function validateSource(source: unknown, rules: readonly SourceRule[], report: Report): void {
  if (typeof source !== 'string' || source.trim() === '') {
    report('missing source URL');
    return;
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    report(`source is not a valid URL: ${source}`);
    return;
  }
  if (url.protocol !== 'https:') {
    report(`source must use https: ${source}`);
  } else if (!isOfficialSource(url, rules)) {
    report(`source is not an official location for this tool: ${url.hostname}${url.pathname}`);
  }
}

function validateDate(verifiedAt: unknown, today: string, report: Report): void {
  if (typeof verifiedAt !== 'string' || !isIsoDate(verifiedAt)) {
    report(`verifiedAt must be a YYYY-MM-DD date, got ${JSON.stringify(verifiedAt) ?? 'nothing'}`);
  } else if (verifiedAt > today) {
    report(`verifiedAt ${verifiedAt} is in the future`);
  }
}

function validateEvidence(evidence: unknown, rules: readonly SourceRule[], today: string, report: Report): void {
  if (typeof evidence !== 'object' || evidence === null) {
    report('evidence must be an object with value, source and verifiedAt');
    return;
  }
  const record = evidence as Record<string, unknown>;
  if (!('value' in record)) report('missing value (use null when the option does not exist)');
  validateSource(record['source'], rules, report);
  validateDate(record['verifiedAt'], today, report);
}

function requireNote(fact: Record<string, unknown>, report: Report): void {
  const note = fact['note'];
  if (typeof note !== 'string' || note.trim() === '') report(`a ${String(fact['status'])} fact needs a note explaining why`);
}

function validateFact(fact: Record<string, unknown>, rules: readonly SourceRule[], today: string, report: Report): void {
  switch (fact['status']) {
    case 'verified':
      validateEvidence(fact, rules, today, report);
      break;
    case 'uncertain':
      validateEvidence(fact, rules, today, report);
      requireNote(fact, report);
      break;
    case 'disputed': {
      requireNote(fact, report);
      const variants = fact['variants'];
      if (!Array.isArray(variants) || variants.length < 2) {
        report('a disputed fact needs at least two variants');
        break;
      }
      variants.forEach((variant: unknown, index) =>
        validateEvidence(variant, rules, today, (message) => report(`variant ${index + 1}: ${message}`)),
      );
      const values = variants.map((variant: unknown) => JSON.stringify((variant as { value?: unknown })?.value));
      if (new Set(values).size !== values.length) report('disputed variants must have different values');
      break;
    }
    default:
      report(`unknown status '${String(fact['status'])}' (expected verified, uncertain or disputed)`);
  }
}

function validateFacts(entry: object, rules: readonly SourceRule[], today: string, add: (path: string, message: string) => void) {
  const walked = walkKnowledge(entry);
  for (const stray of walked.strays) add(stray.path, 'value without a source: wrap it in a fact with source and verifiedAt');
  for (const { path, fact } of walked.facts) {
    validateFact(fact as unknown as Record<string, unknown>, rules, today, (message) => add(path, message));
  }
  return walked;
}

/** The same checks for facts about the environment, against its own list of official locations. */
export function validateEnvironment(environment: EnvironmentKnowledge, today: string): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  validateFacts(environment, ENVIRONMENT_SOURCES, today, (path, message) => issues.push({ tool: 'environment', path, message }));
  return issues;
}

/**
 * Checks that every fact has an official https source and a valid, non-future verification date,
 * that uncertain and disputed facts explain themselves, and that no value is left without a source.
 */
export function validateKnowledge(tools: readonly ToolKnowledge[], today: string): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const toolId = String(tool.id);
    const add = (path: string, message: string) => issues.push({ tool: toolId, path, message });

    if (seen.has(toolId)) add('id', 'duplicate tool id');
    seen.add(toolId);

    const rules = (OFFICIAL_SOURCES as Partial<Record<string, readonly SourceRule[]>>)[toolId];
    if (rules === undefined) {
      add('id', `unknown tool id '${toolId}'`);
      continue;
    }
    if (typeof tool.name !== 'string' || tool.name.trim() === '') add('name', 'missing tool name');
    if (tool.kind !== 'package-manager' && tool.kind !== 'update-bot') add('kind', `unknown kind '${String(tool.kind)}'`);
    if (tool.ecosystem !== undefined && (tool.kind !== 'package-manager' || (tool.ecosystem !== 'npm' && tool.ecosystem !== 'pypi'))) {
      add('ecosystem', `ecosystem '${String(tool.ecosystem)}' is not an ecosystem of a package manager`);
    }

    const { facts, strays } = validateFacts(tool, rules, today, add);

    const present = new Set(facts.map((entry) => entry.path));
    for (const path of requiredFactPaths(tool)) {
      if (!present.has(path) && !strays.some((stray) => stray.path === path)) add(path, 'required fact is missing');
    }
  }
  return issues;
}
