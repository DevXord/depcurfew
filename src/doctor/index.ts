// `depgate doctor`: finds configuration that does not do what it seems to, and drift from depgate.json. Every rule
// reads the repository through the same read-only Repository as detection; nothing is written or executed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy } from '../apply/index.ts';
import { detectProject } from '../detect/index.ts';
import { Repository } from '../detect/repository.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { RULES } from './rules/index.ts';
import type { DoctorReport, Finding, Notice, Rule } from './types.ts';

export type { DoctorReport, Finding, Level, Location, Notice, Rule } from './types.ts';
export { RULES } from './rules/index.ts';
export { countLevels, renderText } from './render.ts';
export { toSarif } from './sarif.ts';

const LEVEL_ORDER = { error: 0, warning: 1, note: 2 } as const;

function byLocation(a: Finding, b: Finding): number {
  if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
  return (a.location.line ?? 0) - (b.location.line ?? 0) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
}

/** Runs the rules on a repository. Throws PolicyError when depgate.json exists but is invalid. */
export function runDoctor(root: string, options: { rules?: readonly Rule[]; tools?: readonly ToolKnowledge[] } = {}): DoctorReport {
  const tools = options.tools ?? knowledgeBase;
  const policy = existsSync(join(root, POLICY_FILE)) ? loadPolicy(root) : undefined;
  const detection = detectProject(root);
  const repository = new Repository(root);
  const findings: Finding[] = [];
  const notices: Notice[] = [];
  const notice = (message: string, file?: string) => {
    if (!notices.some((item) => item.message === message)) notices.push(file === undefined ? { message } : { message, file });
  };
  if (policy === undefined) notice(`no ${POLICY_FILE}: only the rules that do not need a policy ran`);

  for (const rule of options.rules ?? RULES) {
    if (rule.requiresPolicy && policy === undefined) continue;
    rule.check({
      root,
      repository,
      detection,
      policy,
      tools,
      report: ({ level, ...finding }) => findings.push({ rule: rule.id, level: level ?? rule.level, ...finding }),
      notice,
    });
  }
  for (const warning of repository.warnings) notice(warning.message, warning.files[0]);
  return { schemaVersion: 1, policy: policy === undefined ? 'missing' : 'valid', findings: findings.sort(byLocation), notices };
}
