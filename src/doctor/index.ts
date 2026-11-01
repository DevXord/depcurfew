// `depcurfew doctor`: finds configuration that does not do what it seems to, and drift from depcurfew.json. Every rule
// reads the repository through the same read-only Repository as detection; nothing is written or executed.
import { join } from 'node:path';
import { loadPolicyIfPresent, planDetails, PolicyError, projectFiles, type ApplyReport, type PlanOptions } from '../apply/index.ts';
import { inProject, projectProblems, relocateText } from '../apply/projects.ts';
import { detectProject } from '../detect/index.ts';
import { Repository } from '../detect/repository.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { plannedFor } from './plan.ts';
import { ruleResults } from './render.ts';
import { RULES } from './rules/index.ts';
import { UNREADABLE_WARNINGS, unreadableConfig } from './rules/unreadable-config.ts';
import type { Detection } from '../detect/types.ts';
import type { Checked, DoctorReport, Finding, Notice, ProjectView, Rule } from './types.ts';

export type { Checked, CheckedTool, DoctorReport, Finding, Level, Location, Notice, ProjectView, Rule, RuleResult, RuleScope } from './types.ts';
export { RULES } from './rules/index.ts';
export { countLevels, renderText, ruleResults } from './render.ts';
export { toSarif } from './sarif.ts';
export { annotationCommands, cleanNotice, failureSummary, jobSummary } from './github.ts';

const LEVEL_ORDER = { error: 0, warning: 1, note: 2 } as const;

function byLocation(a: Finding, b: Finding): number {
  if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
  return (a.location.line ?? 0) - (b.location.line ?? 0) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
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
  const notice = (message: string, file?: string) => {
    if (!notices.some((item) => item.message === message)) notices.push(file === undefined ? { message } : { message, file });
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
      notice,
    });
  }
  const reported = rules.includes(unreadableConfig);
  for (const warning of repository.warnings) {
    if (!reported || !(warning.code in UNREADABLE_WARNINGS)) notice(warning.message, warning.files[0]);
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
      notice.file === undefined ? { message: `${project}: ${text(notice.message)}` } : { message: text(notice.message), file: inProject(project, notice.file) },
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
  const plans = policy === undefined ? [] : views.map((view) => planDetails(plannedFor(view.root, policy, view.detection, tools, { project: view.directory })));
  const rootPlan: PlanOptions | undefined =
    views.length === 0
      ? undefined
      : { projects: { managerMinutes: plans.flatMap((details) => details?.managerMinutes ?? []), targets: new Set(plans.flatMap((details) => [...(details?.targets ?? [])])) } };

  const projectRuns = views.map((view) => ({
    view,
    run: runRules(view.root, policy, rules, tools, { detection: view.detection, repository: view.repository, project: view.directory, plan: { project: view.directory } }),
  }));
  const rootRun = runRules(root, policy, rules, tools, { detection, ...(views.length === 0 ? {} : { projects: views }), ...(rootPlan === undefined ? {} : { plan: rootPlan }) });

  const notices: Notice[] = [];
  const addNotice = (item: Notice) => {
    if (!notices.some((known) => known.message === item.message)) notices.push(item);
  };
  if (invalid) addNotice({ message: `${POLICY_FILE} is invalid: only the rules that do not need a policy ran` });
  else if (policy === undefined) addNotice({ message: `no ${POLICY_FILE}: only the rules that do not need a policy ran` });
  const findings = [...rootRun.findings];
  for (const item of rootRun.notices) addNotice(item);
  for (const { view, run } of projectRuns) {
    const relocated = relocateRun(view.directory, run, policy === undefined ? undefined : plannedFor(view.root, policy, view.detection, tools, { project: view.directory }));
    findings.push(...relocated.findings);
    for (const item of relocated.notices) addNotice(item);
  }
  const sorted = findings.sort(byLocation);
  const rootChecked = checkedOf(detection, rootRun.repository, tools, policy !== undefined || invalid);
  const projectChecked = projectRuns.map(({ view, run }) => {
    const checked = checkedOf(run.detection, run.repository, tools, false);
    return {
      tools: checked.tools.map((tool) => ({ ...tool, project: view.directory, ...(tool.versionFrom === undefined ? {} : { versionFrom: inProject(view.directory, tool.versionFrom) }) })),
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
      // Each rule once, with the findings of every directory; invalid-policy has nothing to check without a depcurfew.json.
      rules: ruleResults(
        rules,
        sorted,
        (rule) => policy === undefined && !invalid && (rule.requiresPolicy || rule.id === 'invalid-policy'),
        (rule) => rule.applies === undefined || scopes.some((scope) => rule.applies?.(scope) === true),
      ),
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
  for (const file of [...detection.node.versions.map((declaration) => declaration.file), ...detection.dockerfiles.map((dockerfile) => dockerfile.file)]) files.add(file);
  for (const declaration of detection.workspaces?.declarations ?? []) files.add(declaration.file);
  if (policyRead) files.add(POLICY_FILE);
  return { tools: found, files: [...files].filter((file) => file !== '' && repository.isFile(file)).sort() };
}
