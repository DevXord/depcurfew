// `depcurfew doctor`: finds configuration that does not do what it seems to, and drift from depcurfew.json. Every rule
// reads the repository through the same read-only Repository as detection; nothing is written or executed.
import { loadPolicyIfPresent, PolicyError } from '../apply/index.ts';
import { detectProject } from '../detect/index.ts';
import { Repository } from '../detect/repository.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { ruleResults } from './render.ts';
import { RULES } from './rules/index.ts';
import { UNREADABLE_WARNINGS, unreadableConfig } from './rules/unreadable-config.ts';
import type { Detection } from '../detect/types.ts';
import type { Checked, DoctorReport, Finding, Notice, Rule } from './types.ts';

export type { Checked, CheckedTool, DoctorReport, Finding, Level, Location, Notice, Rule, RuleResult } from './types.ts';
export { RULES } from './rules/index.ts';
export { countLevels, renderText, ruleResults } from './render.ts';
export { toSarif } from './sarif.ts';
export { annotationCommands, cleanNotice, failureSummary, jobSummary } from './github.ts';

const LEVEL_ORDER = { error: 0, warning: 1, note: 2 } as const;

function byLocation(a: Finding, b: Finding): number {
  if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
  return (a.location.line ?? 0) - (b.location.line ?? 0) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
}

/**
 * Runs the rules on a repository. When depcurfew.json exists but is invalid, it throws PolicyError, or with
 * invalidPolicy: 'report' runs the rules that need no policy and reports the problems as an invalid-policy finding.
 */
export function runDoctor(
  root: string,
  options: { rules?: readonly Rule[]; tools?: readonly ToolKnowledge[]; invalidPolicy?: 'throw' | 'report' } = {},
): DoctorReport {
  const tools = options.tools ?? knowledgeBase;
  let policy: ResolvedPolicy | undefined;
  let invalid = false;
  try {
    policy = loadPolicyIfPresent(root);
  } catch (error) {
    if (!(error instanceof PolicyError) || options.invalidPolicy !== 'report') throw error;
    invalid = true;
  }
  const detection = detectProject(root);
  const repository = new Repository(root);
  const findings: Finding[] = [];
  const notices: Notice[] = [];
  const notice = (message: string, file?: string) => {
    if (!notices.some((item) => item.message === message)) notices.push(file === undefined ? { message } : { message, file });
  };
  if (invalid) notice(`${POLICY_FILE} is invalid: only the rules that do not need a policy ran`);
  else if (policy === undefined) notice(`no ${POLICY_FILE}: only the rules that do not need a policy ran`);

  const rules = options.rules ?? RULES;
  for (const rule of rules) {
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
  const reported = rules.includes(unreadableConfig);
  for (const warning of repository.warnings) {
    if (!reported || !(warning.code in UNREADABLE_WARNINGS)) notice(warning.message, warning.files[0]);
  }
  const sorted = findings.sort(byLocation);
  return {
    schemaVersion: 1,
    policy: invalid ? 'invalid' : policy === undefined ? 'missing' : 'valid',
    findings: sorted,
    notices,
    checked: {
      ...checkedOf(detection, repository, tools, policy !== undefined || invalid),
      // invalid-policy has nothing to check without a depcurfew.json, like the rules that compare with one.
      rules: ruleResults(rules, sorted, (rule) => policy === undefined && !invalid && (rule.requiresPolicy || rule.id === 'invalid-policy')),
      policyFile: POLICY_FILE,
    },
  };
}

/** The tools found and the files read by detection and the rules, for the log of what doctor checked. */
function checkedOf(detection: Detection, repository: Repository, tools: readonly ToolKnowledge[], policyRead: boolean): Pick<Checked, 'tools' | 'files'> {
  const name = (id: string) => tools.find((tool) => tool.id === id)?.name ?? id;
  const found: Checked['tools'] = [
    ...detection.packageManagers
      .filter((manager) => manager.supported)
      .map((manager) => {
        const declared = manager.versions.find((declaration) => 'version' in declaration);
        return {
          id: manager.id,
          name: name(manager.id),
          ...(declared === undefined || !('version' in declared) ? {} : { version: declared.version, versionFrom: declared.file }),
        };
      }),
    ...detection.bots.map((bot) => ({ id: bot.id, name: name(bot.id) })),
  ];
  const files = new Set<string>(repository.read);
  for (const manager of detection.packageManagers) {
    for (const file of [...manager.evidence.map((evidence) => evidence.file), ...manager.configFiles, ...manager.versions.map((declaration) => declaration.file)]) files.add(file);
  }
  for (const file of [...detection.bots.flatMap((bot) => bot.configFiles), ...detection.npmrcFiles, ...detection.workflows]) files.add(file);
  for (const declaration of detection.workspaces?.declarations ?? []) files.add(declaration.file);
  if (policyRead) files.add(POLICY_FILE);
  return { tools: found, files: [...files].filter((file) => file !== '' && repository.isFile(file)).sort() };
}
