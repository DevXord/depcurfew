import { wildcardMatch } from '../detect/wildcard.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { convertCooldown } from './convert.ts';
import { ecosystemOf } from './package-pattern.ts';
import { normalizePythonName } from './python-names.ts';
import { cooldownShape, installScriptsShape, policyShape, targetsShape, type ResolvedPolicy } from './schema.ts';
import { formatPath, type Issue, type Shape } from './shape.ts';

export type PolicyIssue = Issue;

export type PolicyResult = { ok: true; policy: ResolvedPolicy } | { ok: false; issues: PolicyIssue[] };

/** Parses one section on its own, so rules spanning several fields still run when another part of the file is invalid. */
function section<Out>(shape: Shape<unknown, Out>, document: unknown, key: string): Out | undefined {
  if (typeof document !== 'object' || document === null || !(key in document)) return undefined;
  const result = shape.parse((document as Record<string, unknown>)[key], [key], []);
  return result.ok ? result.value : undefined;
}

/** A pattern as compared across the two lists: Python names normalized, so pypi:Foo_Bar and pypi:foo-bar are one. */
function comparable(pattern: string): string {
  return ecosystemOf(pattern) === 'pypi' ? normalizePythonName(pattern) : pattern;
}

/** A package can be allowed or denied, not both: the same entry, or an entry of one list covered by a pattern of the other. */
function overlaps(allow: readonly string[], deny: readonly string[]): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const advice = 'a package is either allowed or denied, so remove it from one list';
  for (const denied of deny) {
    for (const allowed of allow) {
      const [d, a] = [comparable(denied), comparable(allowed)];
      if (d === a) {
        issues.push({ path: formatPath(['installScripts', 'deny']), message: `"${denied}" is also in installScripts.allow; ${advice}` });
      } else if (wildcardMatch(d, a)) {
        issues.push({ path: formatPath(['installScripts', 'deny']), message: `"${denied}" is also covered by "${allowed}" in installScripts.allow; ${advice}` });
      } else if (wildcardMatch(a, d)) {
        issues.push({ path: formatPath(['installScripts', 'allow']), message: `"${allowed}" is also covered by "${denied}" in installScripts.deny; ${advice}` });
      }
    }
  }
  return issues;
}

function crossFieldIssues(document: unknown, tools: readonly ToolKnowledge[]): PolicyIssue[] {
  const issues: PolicyIssue[] = [];

  const installScripts = section(installScriptsShape, document, 'installScripts');
  if (installScripts?.default === 'allow' && installScripts.allow.length > 0) {
    issues.push({
      path: formatPath(['installScripts', 'allow']),
      message: 'has no effect when default is "allow"; remove the list or set default to "deny"',
    });
  }

  if (installScripts?.default === 'allow' && installScripts.deny.length > 0) {
    issues.push({
      path: formatPath(['installScripts', 'deny']),
      message: 'has no effect when default is "allow"; remove the list or set default to "deny"',
    });
  }
  if (installScripts !== undefined) issues.push(...overlaps(installScripts.allow, installScripts.deny));

  // With "auto", the targets are known only after detection, so apply checks the limits there.
  const cooldown = section(cooldownShape, document, 'cooldown');
  const targets = section(targetsShape, document, 'targets');
  if (cooldown !== undefined && Array.isArray(targets)) {
    for (const id of targets) {
      const tool = tools.find((candidate) => candidate.id === id);
      if (tool === undefined) continue;
      const conversion = convertCooldown(tool, cooldown.minimum);
      if (!conversion.ok) issues.push({ path: formatPath(['cooldown', 'minimum']), message: conversion.reason });
    }
  }
  return issues;
}

/** Validates a parsed policy document and fills in defaults. Reports every problem, each with the path to its field. */
export function validatePolicy(document: unknown, tools: readonly ToolKnowledge[] = knowledgeBase): PolicyResult {
  const issues: PolicyIssue[] = [];
  const result = policyShape.parse(document, [], issues);
  issues.push(...crossFieldIssues(document, tools));
  if (result.ok && issues.length === 0) return { ok: true, policy: result.value };
  return { ok: false, issues };
}

/**
 * V8 reports e.g. `Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)` or
 * `Unexpected non-whitespace character after JSON at position 14`; older versions omit the line and column.
 */
function jsonErrorMessage(error: unknown, source: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const located = /^(.*?) (in|after) JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/su.exec(message);
  if (located === null) return `invalid JSON: ${message}`;
  const [, text = message, where = 'in', position = '0'] = located;
  const reason = where === 'after' ? `${text} after the JSON value` : text;
  let line = located[4];
  let column = located[5];
  if (line === undefined || column === undefined) {
    const before = source.slice(0, Number(position)).split('\n');
    line = String(before.length);
    column = String((before.at(-1)?.length ?? 0) + 1);
  }
  return `invalid JSON at line ${line}, column ${column}: ${reason}`;
}

/** Parses and validates the text of a policy file. */
export function parsePolicy(source: string, tools: readonly ToolKnowledge[] = knowledgeBase): PolicyResult {
  const text = source.startsWith('﻿') ? source.slice(1) : source;
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { ok: false, issues: [{ path: formatPath([]), message: jsonErrorMessage(error, text) }] };
  }
  return validatePolicy(document, tools);
}

export function formatIssue(issue: PolicyIssue): string {
  return `${issue.path}: ${issue.message}`;
}
