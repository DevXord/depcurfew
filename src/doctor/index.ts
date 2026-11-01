// `depcurfew doctor`: finds configuration that does not do what it seems to, and drift from depcurfew.json. Every rule
// reads the repository through the same read-only Repository as detection; nothing is written or executed.
import { join } from 'node:path';
import { loadPolicyIfPresent, planDetails, PolicyError, projectFiles, projectPlanOptions, type ApplyReport, type PlanOptions } from '../apply/index.ts';
import { inProject, projectProblems, relocateText } from '../apply/projects.ts';
import { detectProject } from '../detect/index.ts';
import { Repository } from '../detect/repository.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { values } from '../apply/facts.ts';
import { plannedFor } from './plan.ts';
import { ruleResults } from './render.ts';
import { RULES } from './rules/index.ts';
import { UNREADABLE_WARNINGS, unreadableConfig } from './rules/unreadable-config.ts';
import { DETECTION_NOTICES, WARNING_FIXES } from './unreadable-warnings.ts';
import type { Detection } from '../detect/types.ts';
import { makeNotice, relocatedNotice, type Checked, type DoctorReport, type Finding, type Notice, type ProjectView, type Rule } from './types.ts';

export type { Checked, CheckedTool, DoctorReport, Finding, Level, Location, Notice, ProjectView, Rule, RuleResult, RuleScope } from './types.ts';
export { makeNotice } from './types.ts';
export { RULES } from './rules/index.ts';
export { countLevels, renderText, ruleResults } from './render.ts';
export { toSarif } from './sarif.ts';
export { annotationCommands, cleanNotice, failureSummary, jobSummary } from './github.ts';

const LEVEL_ORDER = { error: 0, warning: 1, note: 2 } as const;

function byLocation(a: Finding, b: Finding): number {
  if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
  return (a.location.line ?? 0) - (b.location.line ?? 0) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
}

/** The most findings of one rule shown at one place that differ only in numbers (decision D-109). */
const MAX_SIMILAR = 10;

/**
 * The findings once each (decision D-109): a finding with the same rule, level, place, message and fix as an earlier
 * one is left out (each setup step with the same matrix value gave the same finding again). At one place, findings of
 * one rule and level that differ only in numbers (the install line of each of 200 setup steps) are shown up to
 * MAX_SIMILAR times, and one more finding of the same level says how many are left out, so the counts and the exit
 * code keep their meaning. Linear in the number of findings.
 */
export function condensed(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const similar = new Map<string, { shown: number; hidden: number; first: Finding }>();
  const kept: Finding[] = [];
  for (const finding of findings) {
    const place = `${finding.rule}\u0000${finding.level}\u0000${finding.location.file}\u0000${finding.location.line ?? ''}\u0000${finding.location.variable ?? ''}`;
    const key = `${place}\u0000${finding.message}\u0000${finding.fix ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const shape = `${place}\u0000${finding.message.replace(/\d+/gu, '#')}\u0000${(finding.fix ?? '').replace(/\d+/gu, '#')}`;
    const group = similar.get(shape) ?? { shown: 0, hidden: 0, first: finding };
    similar.set(shape, group);
    if (group.shown < MAX_SIMILAR) {
      group.shown += 1;
      kept.push(finding);
    } else {
      group.hidden += 1;
    }
  }
  for (const { hidden, first } of similar.values()) {
    if (hidden === 0) continue;
    kept.push({
      rule: first.rule,
      level: first.level,
      location: first.location,
      message: `${hidden} more ${first.rule} ${hidden === 1 ? 'finding' : 'findings'} at this place ${hidden === 1 ? 'differs' : 'differ'} from the ones above only in numbers (line numbers or versions) and ${hidden === 1 ? 'is' : 'are'} not shown`,
      ...(first.fix === undefined ? {} : { fix: `Fix the ones above the same way, then run depcurfew doctor again to see the rest` }),
    });
  }
  return kept;
}

/**
 * A fix that runs depcurfew apply, while an entry of projects cannot be used: apply writes nothing until it is fixed, so
 * the fix says so first (decision D-115). invalid-project's own findings say what to change in projects.
 */
function applyWaits(finding: Finding, count: number): Finding {
  if (finding.rule === 'invalid-project' || finding.fix === undefined || !finding.fix.includes('depcurfew apply')) return finding;
  const entries = count === 1 ? 'the entry of projects' : 'the entries of projects';
  return { ...finding, fix: `First fix ${entries} in ${POLICY_FILE} that invalid-project reports, because depcurfew apply writes nothing until then; then ${finding.fix.charAt(0).toLowerCase()}${finding.fix.slice(1)}` };
}

/** What the rules found in one directory: the root or a project. */
interface DirectoryRun {
  findings: Finding[];
  notices: Notice[];
  detection: Detection;
  repository: Repository;
}

/** Runs the rules on one directory, with the policy of the repository root. */
function runRules(
  root: string,
  policy: ResolvedPolicy | undefined,
  rules: readonly Rule[],
  tools: readonly ToolKnowledge[],
  where: { detection?: Detection; project?: string; projects?: readonly ProjectView[]; plan?: PlanOptions; repository?: Repository } = {},
): DirectoryRun {
  const detection = where.detection ?? detectProject(root, tools);
  const repository = where.repository ?? new Repository(root);
  const findings: Finding[] = [];
  const notices: Notice[] = [];
  const messages = new Set<string>();
  const notice = (code: string, message: string, file?: string, fix?: string) => {
    if (messages.has(message)) return;
    messages.add(message);
    notices.push(makeNotice(code, message, file, fix));
  };
  for (const rule of rules) {
    if (rule.requiresPolicy && policy === undefined) continue;
    rule.check({
      root,
      repository,
      detection,
      policy,
      tools,
      ...(where.project === undefined ? {} : { project: where.project }),
      ...(where.projects === undefined ? {} : { projects: where.projects }),
      ...(where.plan === undefined ? {} : { plan: where.plan }),
      report: ({ level, ...finding }) => findings.push({ rule: rule.id, level: level ?? rule.level, ...finding }),
      notice: (message, file, fix) => notice(rule.id, message, file, fix),
    });
  }
  const reported = rules.includes(unreadableConfig);
  for (const warning of repository.warnings) {
    if (!reported || !(warning.code in UNREADABLE_WARNINGS)) notice(warning.code, warning.message, warning.files[0], WARNING_FIXES[warning.code]);
  }
  // What detection could not follow, so the rules did not check it (decision D-121).
  for (const warning of detection.warnings) {
    if (DETECTION_NOTICES.has(warning.code)) notice(warning.code, warning.message, warning.files[0], WARNING_FIXES[warning.code]);
  }
  return { findings, notices, detection, repository };
}

/** The findings and notices of a project, with every file named relative to the repository root. */
function relocateRun(project: string, run: DirectoryRun, plan: ApplyReport | undefined): Pick<DirectoryRun, 'findings' | 'notices'> {
  const files = projectFiles(run.detection, plan);
  for (const file of run.repository.read) files.add(file);
  for (const finding of run.findings) files.add(finding.location.file);
  for (const notice of run.notices) if (notice.file !== undefined) files.add(notice.file);
  const text = (value: string) => relocateText(value, project, files);
  return {
    findings: run.findings.map((finding) => ({
      ...finding,
      // depcurfew.json is the root's: a finding there is about the policy, which the project shares.
      location: { ...finding.location, file: finding.location.file === POLICY_FILE ? POLICY_FILE : inProject(project, finding.location.file) },
      message: text(finding.message),
      ...(finding.fix === undefined ? {} : { fix: text(finding.fix) }),
    })),
    notices: run.notices.map((notice) =>
      notice.file === undefined ? relocatedNotice(notice, `${project}: ${text(notice.message)}`, undefined) : relocatedNotice(notice, text(notice.message), inProject(project, notice.file)),
    ),
  };
}

/**
 * Runs the rules on a repository. When depcurfew.json exists but is invalid, it throws PolicyError, or with
 * invalidPolicy: 'report' runs the rules that need no policy and reports the problems as an invalid-policy finding.
 * `policy` passes the policy in instead of reading depcurfew.json (null: run as without one). With projects in the
 * policy, the rules also run on every listed directory with the same policy, and the report covers them all, with
 * paths relative to the root (decision D-100).
 */
export function runDoctor(
  root: string,
  options: { rules?: readonly Rule[]; tools?: readonly ToolKnowledge[]; invalidPolicy?: 'throw' | 'report'; policy?: ResolvedPolicy | null } = {},
): DoctorReport {
  const tools = options.tools ?? knowledgeBase;
  let policy: ResolvedPolicy | undefined;
  let invalid = false;
  if (options.policy !== undefined) policy = options.policy ?? undefined;
  else {
    try {
      policy = loadPolicyIfPresent(root);
    } catch (error) {
      if (!(error instanceof PolicyError) || options.invalidPolicy !== 'report') throw error;
      invalid = true;
    }
  }
  const rules = options.rules ?? RULES;
  const detection = detectProject(root, tools);

  // The listed directories that can be read; invalid-project reports the others.
  const listed = policy?.projects ?? [];
  const problems = projectProblems(root, listed, detection);
  const views: ProjectView[] = listed
    .filter((project) => !problems.some((problem) => problem.project === project))
    .map((project) => {
      const directory = join(root, project);
      return { directory: project, root: directory, repository: new Repository(directory), detection: detectProject(directory, tools) };
    });
  // The bots of the root wait as long as the package managers of every project (planRepository plans the same way).
  const plans = policy === undefined ? [] : views.map((view) => planDetails(plannedFor(view.root, policy, view.detection, tools, projectPlanOptions(detection, view.directory, view.detection))));
  const rootPlan: PlanOptions | undefined =
    views.length === 0
      ? undefined
      : { projects: { managerMinutes: plans.flatMap((details) => details?.managerMinutes ?? []), targets: new Set(plans.flatMap((details) => [...(details?.targets ?? [])])) } };

  const projectRuns = views.map((view) => ({
    view,
    run: runRules(view.root, policy, rules, tools, { detection: view.detection, repository: view.repository, project: view.directory, plan: projectPlanOptions(detection, view.directory, view.detection) }),
  }));
  const rootRun = runRules(root, policy, rules, tools, { detection, ...(views.length === 0 ? {} : { projects: views }), ...(rootPlan === undefined ? {} : { plan: rootPlan }) });

  const notices: Notice[] = [];
  const shown = new Set<string>();
  const addNotice = (item: Notice) => {
    if (shown.has(item.message)) return;
    shown.add(item.message);
    notices.push(item);
  };
  // The policy's state, with the codes of apply's errors for it; the invalid-policy finding says how to fix an invalid one.
  if (invalid) addNotice(makeNotice('policy-invalid', `${POLICY_FILE} is invalid: only the rules that do not need a policy ran`, POLICY_FILE, 'Fix what the invalid-policy finding lists, then run depcurfew doctor again'));
  else if (policy === undefined) addNotice(makeNotice('policy-missing', `no ${POLICY_FILE}: only the rules that do not need a policy ran`, undefined, `Run depcurfew init to write ${POLICY_FILE}, so that the rules that compare the repository with it run too`));
  const findings = [...rootRun.findings];
  for (const item of rootRun.notices) addNotice(item);
  for (const { view, run } of projectRuns) {
    const relocated = relocateRun(view.directory, run, policy === undefined ? undefined : plannedFor(view.root, policy, view.detection, tools, projectPlanOptions(detection, view.directory, view.detection)));
    findings.push(...relocated.findings);
    for (const item of relocated.notices) addNotice(item);
  }
  const sorted = condensed(problems.length === 0 ? findings : findings.map((finding) => applyWaits(finding, problems.length))).sort(byLocation);
  const rootChecked = checkedOf(detection, rootRun.repository, tools, policy !== undefined || invalid);
  const projectChecked = projectRuns.map(({ view, run }) => {
    const checked = checkedOf(run.detection, run.repository, tools, false);
    return {
      tools: checked.tools.map((tool) => ({
        ...tool,
        project: view.directory,
        ...(tool.versionFrom === undefined ? {} : { versionFrom: inProject(view.directory, tool.versionFrom) }),
        // A bot reads its configuration only from the repository root (extra.configLocation).
        ...(readFromRoot(tools, tool.id) ? { unread: true as const } : {}),
      })),
      files: checked.files.map((file) => inProject(view.directory, file)),
    };
  });
  // A rule applies when it concerns the root or any project; the files above were counted before applies reads any (decision D-098).
  const scopes = [
    { root, repository: rootRun.repository, detection, policy, tools, ...(views.length === 0 ? {} : { projects: views }) },
    ...views.map((view) => ({ root: view.root, repository: view.repository, detection: view.detection, policy, tools, project: view.directory })),
  ];
  return {
    schemaVersion: 1,
    policy: invalid ? 'invalid' : policy === undefined ? 'missing' : 'valid',
    findings: sorted,
    notices,
    checked: {
      tools: [...rootChecked.tools, ...projectChecked.flatMap((checked) => checked.tools)],
      files: [...new Set([...rootChecked.files, ...projectChecked.flatMap((checked) => checked.files)])].sort(),
      // Each rule once, with the findings of every directory; invalid-policy has nothing to check without a depcurfew.json,
      // and a rule that needs the policy did not run when it is missing or invalid (decision D-115).
      rules: ruleResults(
        rules,
        sorted,
        (rule) => policy === undefined && (rule.requiresPolicy || (!invalid && rule.id === 'invalid-policy')),
        (rule) => rule.applies === undefined || scopes.some((scope) => rule.applies?.(scope) === true),
      ),
      policyFile: POLICY_FILE,
    },
  };
}

/** Whether a bot reads its configuration only from the repository root, so that a project's file of it is not read. */
function readFromRoot(tools: readonly ToolKnowledge[], id: string): boolean {
  const tool = tools.find((entry) => entry.id === id);
  if (tool?.kind !== 'update-bot') return false;
  const fact = tool.extra?.['configLocation'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)['from'] === 'repository-root';
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
  for (const file of [...detection.node.versions.map((declaration) => declaration.file), ...detection.dockerfiles.map((dockerfile) => dockerfile.file)]) files.add(file);
  for (const declaration of detection.workspaces?.declarations ?? []) files.add(declaration.file);
  if (policyRead) files.add(POLICY_FILE);
  return { tools: found, files: [...files].filter((file) => file !== '' && repository.isFile(file)).sort() };
}
